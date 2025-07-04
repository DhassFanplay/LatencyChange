let selectedDeviceId = null;
let unityInstance = null;
let video = null;
let canvas = null;
let ctx = null;
let firstFrameSent = false;
let frameLoopId = null;
let detectLoopId = null;
let templates = [];
let templateSize = 100;
const scale = 0.5;
const baseMatchScore = 0.8;
const lowConfidenceThreshold = 0.65;
const verticalOffset = 0.15;
const maxTemplates = 8;
let trackingLost = false;
let trackingLostFrames = 0;
const trackingLostThreshold = 10;

// Background subtractor for removing static background

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
let bgSubtractor = cv.createBackgroundSubtractorMOG2();

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
    console.log("Setting up camera...");
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
        console.log("Camera stream obtained.");
    } catch (e) {
        console.error(`getUserMedia failed: ${e.name} - ${e.message}`);
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
        console.log("Video metadata loaded.");
    } catch (e) {
        console.error(`Video play error: ${e}`);
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
    console.log(`Template size set to ${templateSize}px.`);

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
        console.log("Unity notified: Camera ready.");
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

    // Convert to grayscale
    const gray = new cv.Mat();
    cv.cvtColor(newTemplate, gray, cv.COLOR_RGBA2GRAY);

    // Resize to small scale
    const resized = new cv.Mat();
    cv.resize(gray, resized, new cv.Size(0, 0), scale, scale, cv.INTER_AREA);

    // Store it for tracking
    templates.push({
        template: gray,
        resizedTemplate: resized
    });

    // Send processed image (grayscale, resized) to Unity
    const processedCanvas = document.createElement("canvas");
    processedCanvas.width = resized.cols;
    processedCanvas.height = resized.rows;
    const processedCtx = processedCanvas.getContext("2d");

    // Convert back to RGBA for canvas
    const rgbaMat = new cv.Mat();
    cv.cvtColor(resized, rgbaMat, cv.COLOR_GRAY2RGBA);
    const imgData = new ImageData(
        new Uint8ClampedArray(rgbaMat.data),
        resized.cols,
        resized.rows
    );
    processedCtx.putImageData(imgData, 0, 0);
    const base64Processed = processedCanvas.toDataURL("image/png");

    const filename = `foot_template_${templates.length}.png`;
    triggerDownload(base64Processed, filename);

    if (unityInstance) {
        unityInstance.SendMessage("CameraManager", "OnReceiveTemplateImage", base64Processed);
    }

    rgbaMat.delete();
    newTemplate.delete();

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

function triggerDownload(dataURL, filename) {
    const link = document.createElement("a");
    link.href = dataURL;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

function autoCaptureTemplates() {
    let count = 0;
    const interval = setInterval(() => {
        if (count >= maxTemplates) {
            clearInterval(interval);
            console.log("Auto-capture complete.");
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

        // Apply background subtraction
        const fgMask = new cv.Mat();
        bgSubtractor.apply(frame, fgMask);

        // Perform template matching on the foreground
        let bestMatch = { score: 0, pt: null, templateSize: null };

        for (let { resizedTemplate } of templates) {
            const result = new cv.Mat();
            cv.matchTemplate(fgMask, resizedTemplate, result, cv.TM_CCOEFF_NORMED);
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

        // Dynamic threshold adjustment
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
                console.log("Tracking recovered");
            }
        } else {
            trackingLostFrames++;
            if (!trackingLost && trackingLostFrames >= trackingLostThreshold) {
                trackingLost = true;
                if (unityInstance) unityInstance.SendMessage("FootCube", "OnTrackingLost");
                console.log("Tracking lost");
            }
        }
        fgMask.delete();
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

function waitForOpenCV() {
    return new Promise(resolve => {
        const check = () => (cv && cv.Mat ? resolve() : setTimeout(check, 100));
        check();
    });
}