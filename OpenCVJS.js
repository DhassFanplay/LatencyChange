let selectedDeviceId = null;
let unityInstance = null;
let video = null;
let canvas = null;
let ctx = null;
let firstFrameSent = false;

let frameLoopId = null;
let detectLoopId = null;

let templates = [];
let matchBuffer = null;

let templateSize = 100;
const scale = 0.5;
const baseMatchScore = 0.8;
const lowConfidenceThreshold = 0.65;
const verticalOffset = 0.15;
const maxTemplates = 8;

let trackingLost = false;
let trackingLostFrames = 0;
const trackingLostThreshold = 10;
let showPreviews = false;

function RegisterUnityInstance(instance) {
    unityInstance = instance;
}

window.RegisterUnityInstance = RegisterUnityInstance;
window.StartFootDetection = StartFootDetection;
window.CaptureFootTemplateFromUnity = CaptureFootTemplateFromUnity;
window.listCameras = listCameras;
window.setupCamera = setupCamera;
window.Recalibration = Recalibration;

async function listCameras() {
    await StartFootDetection();
}

async function StartFootDetection() {
    firstFrameSent = false;
    cancelLoops();
    await waitForOpenCV();
    console.log("OpenCV Loaded");
    await setupCamera();
}

async function Recalibration() {
    const footBox = document.getElementById("footHighlight");
    footBox.style.display = "block";
    templates.forEach(t => {
        t.template.delete();
        t.resizedTemplate.delete();
    });
    templates.length = 0;
    trackingLost = false;
    trackingLostFrames = 0;
    console.log("Templates cleared. Starting auto-capture...");
    autoCaptureTemplates();
}

async function setupCamera() {
    log("Setting up camera...");

    if (video?.srcObject) {
        video.srcObject.getTracks().forEach(track => track.stop());
        video.srcObject = null;
    }

    if (!video) {
        video = document.createElement("video");
        video.setAttribute("autoplay", "");
        video.setAttribute("playsinline", "");
        video.style.position = "absolute";
        video.style.left = "-9999px";
        document.body.appendChild(video);
    }

    const constraints = {
        video: { facingMode: { ideal: "environment" } },
        audio: false
    };

    let stream;
    try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
        log("Camera stream obtained.");
    } catch (e) {
        log(`getUserMedia failed: ${e.name} - ${e.message}`);
        return;
    }

    video.srcObject = stream;

    try {
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject("Timeout loading video metadata"), 3000);
            video.onloadedmetadata = () => {
                clearTimeout(timeout);
                video.play().then(resolve).catch(reject);
            };
        });
        log("Video metadata loaded.");
    } catch (e) {
        log(`Video play error: ${e}`);
        return;
    }

    if (!canvas) {
        canvas = document.createElement("canvas");
        canvas.style.display = "none";
        document.body.appendChild(canvas);
        ctx = canvas.getContext("2d");
    }

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    templateSize = Math.floor(Math.min(video.videoWidth, video.videoHeight) * 0.35);
    log(`Template size set to ${templateSize}px.`);

    const footBox = document.getElementById("footHighlight");
    if (footBox) {
        const screenWidth = window.innerWidth;
        const screenHeight = window.innerHeight;
        footBox.style.width = `${templateSize}px`;
        footBox.style.height = `${templateSize}px`;
        footBox.style.display = "block";

        footBox.style.left = `${(screenWidth - templateSize) / 2}px`;
        footBox.style.top = `${(screenHeight - templateSize) / 2 + screenHeight * verticalOffset}px`;
    }

    if (!firstFrameSent && unityInstance) {
        unityInstance.SendMessage("CameraManager", "OnCameraReady");
        firstFrameSent = true;
        log("Unity notified: Camera ready.");
    }

    startFrameLoop();
}

function CaptureFootTemplateFromUnity() {
    if (!video || video.videoWidth === 0 || video.videoHeight === 0) return;

    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = video.videoWidth;
    tempCanvas.height = video.videoHeight;
    const tempCtx = tempCanvas.getContext("2d");

    tempCtx.drawImage(video, 0, 0);
    const centerX = Math.floor(video.videoWidth / 2);
    const centerY = Math.floor(video.videoHeight / 2 + video.videoHeight * verticalOffset);
    const startX = centerX - templateSize / 2;
    const startY = centerY - templateSize / 2;

    const imageData = tempCtx.getImageData(startX, startY, templateSize, templateSize);
    const newTemplate = cv.matFromImageData(imageData);

    const gray = new cv.Mat();
    cv.cvtColor(newTemplate, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(3, 3), 0);
    cv.Canny(gray, gray, 50, 150); // 🆕 Edge-based shape extraction

    const resized = new cv.Mat();
    cv.resize(gray, resized, new cv.Size(0, 0), scale, scale, cv.INTER_AREA);

    templates.push({
        template: gray,
        resizedTemplate: resized
    });

    const processedCanvas = document.createElement("canvas");
    processedCanvas.width = resized.cols;
    processedCanvas.height = resized.rows;
    const processedCtx = processedCanvas.getContext("2d");

    const rgbaMat = new cv.Mat();
    cv.cvtColor(resized, rgbaMat, cv.COLOR_GRAY2RGBA);
    const imgData = new ImageData(
        new Uint8ClampedArray(rgbaMat.data), resized.cols, resized.rows
    );
    processedCtx.putImageData(imgData, 0, 0);

    const base64Processed = processedCanvas.toDataURL("image/png");
    if (unityInstance) {
        unityInstance.SendMessage("CameraManager", "OnReceiveTemplateImage", base64Processed);
    }

    rgbaMat.delete(); newTemplate.delete();

    console.log(`Template ${templates.length} captured.`);

    if (templates.length >= maxTemplates) {
        const footBox = document.getElementById("footHighlight");
        if (footBox) footBox.style.display = "none";
        if (unityInstance) {
            unityInstance.SendMessage("CameraManager", "OnTemplatesCaptured");
            console.log("Unity notified: Templates Captured");
        }
        startFootDetectionLoop();
    }
}

function autoCaptureTemplates() {
    let count = 0;
    const interval = setInterval(() => {
        if (count >= maxTemplates) {
            clearInterval(interval);
            log("Auto-capture complete.");
            startFootDetectionLoop();
        } else {
            CaptureFootTemplateFromUnity();
            count++;
        }
    }, 250);
}

function startFrameLoop() {
    function sendFrame() {
        if (!video || video.readyState < 2) {
            frameLoopId = requestAnimationFrame(sendFrame);
            return;
        }

        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        const base64 = canvas.toDataURL("image/jpeg");
        if (unityInstance) {
            unityInstance.SendMessage("CameraManager", "OnReceiveVideoFrame", base64);
            if (!firstFrameSent) {
                unityInstance.SendMessage("CameraManager", "OnCameraReady");
                firstFrameSent = true;
            }
        }

        frameLoopId = requestAnimationFrame(sendFrame);
    }
    sendFrame();
}

function startFootDetectionLoop() {
    function detect() {
        if (templates.length === 0) {
            detectLoopId = requestAnimationFrame(detect);
            return;
        }

        ctx.drawImage(video, 0, 0);
        const frameData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const src = cv.matFromImageData(frameData);
        const gray = new cv.Mat();
        const resized = new cv.Mat();

        cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
        cv.GaussianBlur(gray, gray, new cv.Size(3, 3), 0);
        cv.Canny(gray, gray, 50, 150); // 🆕 Edge detection on live frame
        cv.resize(gray, resized, new cv.Size(0, 0), scale, scale, cv.INTER_AREA);

        let bestMatch = { score: 0, pt: null, templateSize: null };

        for (let { resizedTemplate } of templates) {
            const result = new cv.Mat();
            cv.matchTemplate(resized, resizedTemplate, result, cv.TM_CCOEFF_NORMED);
            const minMax = cv.minMaxLoc(result);
            const score = minMax.maxVal;

            if (score > bestMatch.score) {
                bestMatch = {
                    score,
                    pt: minMax.maxLoc,
                    templateSize: resizedTemplate.size()
                };
            }

            result.delete();
        }

        let currentThreshold = trackingLostFrames > trackingLostThreshold ? lowConfidenceThreshold : baseMatchScore;

        if (bestMatch.score > currentThreshold) {
            trackingLostFrames = 0;

            const centerX = (bestMatch.pt.x + bestMatch.templateSize.width / 2) / scale;
            const centerY = (bestMatch.pt.y + bestMatch.templateSize.height / 2) / scale;

            const normalized = {
                x: centerX / canvas.width,
                y: centerY / canvas.height
            };

            if (unityInstance) {
                unityInstance.SendMessage("FootCube", "OnReceiveFootPosition", JSON.stringify(normalized));
            }

            if (trackingLost) {
                trackingLost = false;
                if (unityInstance) unityInstance.SendMessage("FootCube", "OnTrackingRecovered");
                log("Tracking recovered");
            }

        } else {
            trackingLostFrames++;
            if (!trackingLost && trackingLostFrames >= trackingLostThreshold) {
                trackingLost = true;
                if (unityInstance) unityInstance.SendMessage("FootCube", "OnTrackingLost");
                log("Tracking lost");
            }
        }

        src.delete(); gray.delete(); resized.delete();
        detectLoopId = requestAnimationFrame(detect);
    }

    detect();
}

function cancelLoops() {
    if (frameLoopId) cancelAnimationFrame(frameLoopId);
    if (detectLoopId) cancelAnimationFrame(detectLoopId);
    frameLoopId = null;
    detectLoopId = null;
}

function log(msg) {
    console.log(msg);
    const dbg = document.getElementById("debugLog");
    if (dbg) dbg.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
}

function waitForOpenCV() {
    return new Promise(resolve => {
        const check = () => (cv && cv.Mat ? resolve() : setTimeout(check, 100));
        check();
    });
}
