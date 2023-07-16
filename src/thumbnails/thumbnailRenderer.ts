import { Format, getPlaybackFormats } from "./thumbnailData";
import { getFromCache, RenderedThumbnailVideo, setupCache, ThumbnailVideo } from "./thumbnailDataCache";
import { VideoID, getVideoID } from "../maze-utils/video";
import { getNumberOfThumbnailCacheRequests, getVideoThumbnailIncludingUnsubmitted, isFetchingFromThumbnailCache, queueThumbnailCacheRequest, waitForThumbnailCache } from "../dataFetching";
import { log, logError } from "../utils/logger";
import { BrandingLocation, extractVideoIDFromElement } from "../videoBranding/videoBranding";
import { isFirefoxOrSafari, timeoutPomise, waitFor } from "../maze-utils";
import Config, { ThumbnailFallbackOption } from "../config/config";
import { getThumbnailFallbackOption, shouldReplaceThumbnails, shouldReplaceThumbnailsFastCheck } from "../config/channelOverrides";
import { countThumbnailReplacement } from "../config/stats";
import { ThumbnailCacheOption } from "../config/config";

const activeRendersMax = isFirefoxOrSafari() ? 3 : 6;
const activeRenders: Record<VideoID, Promise<RenderedThumbnailVideo | null>> = {};
const renderQueue: Array<() => void> = [];
const renderQueueCallbacks: Record<VideoID, () => void> = {};

function waitForSpotInRenderQueue(videoID: VideoID): Promise<void> {
    if (Object.keys(activeRenders).length >= activeRendersMax) {
        return new Promise((resolve) => {
            renderQueue.push(resolve);
            renderQueueCallbacks[videoID] = resolve;
        });
    }

    return Promise.resolve();
}

function nextInRenderQueue() {
    renderQueue.shift()?.();
}

export function thumbnailCacheDownloaded(videoID: VideoID): void {
    renderQueueCallbacks[videoID]?.();
}

const thumbnailRendererControls: Record<VideoID, Array<(error?: string) => void>> = {};

function stopRendering(videoID: VideoID, error?: string) {
    const control = thumbnailRendererControls[videoID];
    if (control) {
        for (const callback of control) {
            callback(error);
        }
    }

    delete thumbnailRendererControls[videoID];
}

function addStopRenderingCallback(videoID: VideoID, callback: (error?: string) => void) {
    thumbnailRendererControls[videoID] ??= [];
    thumbnailRendererControls[videoID].push(callback);
}

export async function renderThumbnail(videoID: VideoID, width: number,
    height: number, saveVideo: boolean, timestamp: number): Promise<RenderedThumbnailVideo | null> {

    const startTime = performance.now();

    let bestVideoData = await findBestVideo(videoID, width, height, timestamp);
    if (bestVideoData.renderedThumbnail) {
        return bestVideoData.renderedThumbnail;
    }
    
    await Promise.race([
        waitForSpotInRenderQueue(videoID),
        timeoutPomise(Config.config!.renderTimeout - (performance.now() - startTime)).catch(() => ({}))
    ]);
    delete renderQueueCallbacks[videoID];

    if (performance.now() - startTime > Config.config!.renderTimeout) {
        return null;
    }

    bestVideoData = await findBestVideo(videoID, width, height, timestamp);
    if (bestVideoData.renderedThumbnail) {
        return bestVideoData.renderedThumbnail;
    }
    const reusedVideo: HTMLVideoElement | null = bestVideoData.video ?? null;

    // eslint-disable-next-line no-async-promise-executor, @typescript-eslint/no-misused-promises
    return await new Promise(async (resolve, reject) => {
        const start = Date.now();
        const stopCallbackHandler = new Promise<string | undefined>((resolve) => {
            addStopRenderingCallback(videoID, resolve);
        });
        const format = await Promise.race([getPlaybackFormats(videoID, width, height), stopCallbackHandler]);
        const videoCache = setupCache(videoID);
        if (!format || !(format as Format)?.url) {
            handleThumbnailRenderFailure(videoID, width, height, timestamp, resolve);
            return;
        }
        if (typeof(format) === "string") {
            resolve(videoCache.video.find(v => v.timestamp === timestamp && v.rendered && v.fromThumbnailCache) as RenderedThumbnailVideo ?? null);
            return;
        }
        
        const video = createVideo(reusedVideo, format.url, timestamp);
        const videoCacheObject: ThumbnailVideo = {
            video: video,
            width: format.width,
            height: format.height,
            rendered: false,
            onReady: [resolve],
            timestamp
        };
        videoCache.video.push(videoCacheObject);

        let resolved = false;
        let videoLoadedTimeout: NodeJS.Timeout | null = null;

        const clearVideo = (saveVideo: boolean) => {
            video.removeEventListener("error", errorHandler);
            video.removeEventListener("loadeddata", loadedData); // eslint-disable-line @typescript-eslint/no-misused-promises
            video.removeEventListener("seeked", loadedData) // eslint-disable-line @typescript-eslint/no-misused-promises

            if (!saveVideo) {
                video.removeAttribute("src");
                video.load();
                video.remove();
            }
        };

        const loadedData = async () => {
            const betterVideo = getFromCache(videoID)?.video?.find(v => v.width >= width && v.height >= height
                && v.timestamp === timestamp && v.rendered);
            if (betterVideo) {
                video.remove();
                resolved = true;

                reject("Already rendered");
                return;
            }

            log(videoID, "videoLoaded", video.currentTime, video.readyState, video.seeking, format)
            if (video.readyState < 2 || video.seeking) {
                if (videoLoadedTimeout) clearTimeout(videoLoadedTimeout);

                if (video.seeking) {
                    video.addEventListener("seeked", loadedData, { once: true }); // eslint-disable-line @typescript-eslint/no-misused-promises
                } else {
                    videoLoadedTimeout = setTimeout(loadedData, 50); // eslint-disable-line @typescript-eslint/no-misused-promises
                }

                return;
            }

            const videoInfo: RenderedThumbnailVideo = {
                blob: await renderToBlob(video),
                video: saveVideo ? video : null,
                width: video.videoWidth,
                height: video.videoHeight,
                rendered: true,
                onReady: [],
                timestamp,
                fromThumbnailCache: false
            };

            const videoCache = setupCache(videoID);
            const currentVideoInfoIndex = videoCache.video.findIndex(v => v.width === video.videoWidth
                && v.height === video.videoHeight && v.timestamp === timestamp);
            const currentVideoInfo = currentVideoInfoIndex !== -1 ? videoCache.video[currentVideoInfoIndex] : null;
            if (currentVideoInfo) {
                for (const callback of currentVideoInfo.onReady) {
                    callback(videoInfo);
                }

                videoCache.video[currentVideoInfoIndex] = videoInfo;
            } else {
                videoCache.video.push(videoInfo);
            }

            log(videoID, (Date.now() - start) / 1000, width > 0 ? "full" : "smaller");

            clearVideo(saveVideo);
            resolved = true;
        };

        const errorHandler = () => void (() => {
            if (!resolved) {
                if (videoLoadedTimeout) clearTimeout(videoLoadedTimeout);

                clearVideo(false);
                handleThumbnailRenderFailure(videoID, width, height, timestamp, resolve);
            }
        })();

        video.addEventListener("error", errorHandler);
        if (reusedVideo) {
            video.addEventListener("seeked", loadedData); // eslint-disable-line @typescript-eslint/no-misused-promises
        } else {
            video.addEventListener("loadeddata", loadedData); // eslint-disable-line @typescript-eslint/no-misused-promises
        }

        // Give up after some times
        setTimeout(() => {
            if (!resolved) {
                errorHandler();
            }
        }, Config.config!.renderTimeout - (performance.now() - startTime));

        addStopRenderingCallback(videoID, () => {
            resolved = true;
            clearVideo(false);

            reject("Stopped while waiting for video to load");
        });
    });
}

interface BestVideoData {
    renderedThumbnail?: Promise<RenderedThumbnailVideo | null>;
    video?: HTMLVideoElement | null;
}

function findBestVideo(videoID: VideoID, width: number, height: number, timestamp: number): BestVideoData {
    const existingCache = getFromCache(videoID);

    if (existingCache && existingCache?.video?.length > 0) {
        const bestVideos = ((width && height) ? existingCache.video.filter(v => (v.rendered && v.fromThumbnailCache)
                || (v.width >= width && v.height >= height))
            : existingCache.video).sort((a, b) => b.width - a.width).sort((a, b) => +b.rendered - +a.rendered);

        const sameTimestamp = bestVideos.find(v => v.timestamp === timestamp);

        if (sameTimestamp?.rendered) {
            return {
                renderedThumbnail: Promise.resolve(sameTimestamp)
            };
        } else if (sameTimestamp) {
            return {
                renderedThumbnail: new Promise((resolve) => {
                    sameTimestamp.onReady.push((a) => {
                        resolve(a)
                    });
                })
            };
        } else if (bestVideos.length > 0) {
            return {
                video: bestVideos[0].video
            };
        }
    }

    return {};
}

function handleThumbnailRenderFailure(videoID: VideoID, width: number, height: number,
        timestamp: number, resolve: (video: RenderedThumbnailVideo | null) => void): void {
    const videoCache = setupCache(videoID);
    const thumbnailFailed = !!videoCache.thumbnailCachesFailed?.has?.(timestamp);
    const listeners = [resolve];

    if (videoCache.video) {
        const filter = v => v.width !== width && v.height !== height && v.timestamp !== timestamp;
        const removedItems = videoCache.video.filter((v) => !filter(v));
        videoCache.video = videoCache.video.filter(filter);

        listeners.push(...removedItems.flatMap((v) => v.onReady));
    }

    if (!thumbnailFailed && Config.config!.thumbnailCacheUse !== ThumbnailCacheOption.Disable) {
        // Force the thumbnail to be generated by the server
        queueThumbnailCacheRequest(videoID, timestamp, undefined, false, true);

        videoCache.failures.push({
            timestamp,
            onReady: [...listeners]
        });
    } else {
        for (const callback of listeners) {
            callback(null);
        }
    }
}

function renderToBlob(surface: HTMLVideoElement | HTMLCanvasElement): Promise<Blob> {
    let deleteSurface = false;
    if (surface instanceof HTMLVideoElement) {
        const canvas = document.createElement("canvas");
        canvas.width = surface.videoWidth;
        canvas.height = surface.videoHeight;
        canvas.getContext("2d")!.drawImage(surface, 0, 0);

        surface = canvas;
        deleteSurface = true;
    }

    return new Promise((resolve, reject) => {
        (surface as HTMLCanvasElement).toBlob((blob) => {
            if (deleteSurface) {
                surface.remove();
            }
            if (blob) {
                resolve(blob);
            } else {
                reject("Failed to create blob");
            }
        }, "image/webp", 1);
    });
}

/**
 * Returns a canvas that will be drawn to once the thumbnail is ready.
 * 
 * Starts with lower resolution and replaces it with higher resolution when ready.
 */
export async function createThumbnailImageElement(existingElement: HTMLImageElement | null, videoID: VideoID, width: number,
    height: number, brandingLocation: BrandingLocation, forcedTimestamp: number | null,
    saveVideo: boolean, stillValid: () => Promise<boolean>, ready: (image: HTMLImageElement) => unknown,
    failure: () => unknown): Promise<HTMLImageElement | null> {

    let timestamp = forcedTimestamp as number;
    if (timestamp === null) {
        try {
            const thumbnail = await getVideoThumbnailIncludingUnsubmitted(videoID, brandingLocation);
            if (thumbnail && !thumbnail.original) {
                timestamp = thumbnail.timestamp;
            } else {
                // Original thumbnail will be shown automatically
                return null;
            }
        } catch (e) {
            return null;
        }
    }

    let waitingForFetchTries = 0;
    while (isFetchingFromThumbnailCache(videoID, timestamp)) {
        // Wait for the thumbnail to be fetched from the cache before trying local generation
        try {
            const promises = [
                waitForThumbnailCache(videoID),
                timeoutPomise(Config.config!.startLocalRenderTimeout).catch(() => ({}))
            ];

            // If we know about it, we don't want to return early without using the timeout
            if (shouldReplaceThumbnailsFastCheck(videoID) === null) {
                promises.push(shouldReplaceThumbnails(videoID));
            }

            await Promise.race(promises);

            if (isFetchingFromThumbnailCache(videoID, timestamp) 
                    && getNumberOfThumbnailCacheRequests() > 3 && waitingForFetchTries < 5
                    && shouldReplaceThumbnailsFastCheck(videoID) !== false) {
                waitingForFetchTries++;
                log(videoID, "Lots of thumbnail cache requests in progress, waiting a little longer");
            } else {
                break;
            }
        } catch (e) {
            // Go on and do a local render
            break;
        }
    }

    if (!await stillValid()) {
        return null;
    }

    const image = existingElement ?? document.createElement("img");
    image.style.display = "none";

    const result = async (canvasInfo: RenderedThumbnailVideo | null) => {
        delete activeRenders[videoID];
        nextInRenderQueue();

        if (!await stillValid()) {
            return;
        }

        if (!canvasInfo) {
            failure();
            return;
        }

        drawBlob(image, canvasInfo.blob);
        ready(image);
    }

    const activeRender = activeRenders[videoID] ?? renderThumbnail(videoID, width, height, saveVideo, timestamp);
    activeRenders[videoID] = activeRender;
    
    activeRender.then(result).catch(() => {
        // Try again with lower resolution
        renderThumbnail(videoID, 0, 0, saveVideo, timestamp).then(result).catch(() => {
            logError(`Failed to render thumbnail for ${videoID}`);
        });
    });

    return image;
}

export function drawBlob(image: HTMLImageElement, blob: Blob): void {
    image.src = URL.createObjectURL(blob);
}

export function drawCenteredToCanvas(canvas: HTMLCanvasElement, width: number, height: number,
    originalWidth: number, originalHeight: number, originalSurface: HTMLVideoElement | HTMLCanvasElement | ImageBitmap): void {
    const calculateWidth = height * originalWidth / originalHeight;
    const context = canvas.getContext("2d")!;
    
    context.drawImage(originalSurface, (width - calculateWidth) / 2, 0, calculateWidth, height);
}

function createVideo(existingVideo: HTMLVideoElement | null, url: string, timestamp: number): HTMLVideoElement {
    if (timestamp === 0 && !isFirefoxOrSafari()) timestamp += 0.001;
    
    const video = existingVideo ?? document.createElement("video");
    video.crossOrigin = "anonymous";
    // https://stackoverflow.com/a/69074004
    if (!existingVideo) video.src = `${url}#t=${timestamp}-${timestamp + 0.001}`;
    video.currentTime = timestamp;
    video.controls = false;
    video.pause();
    video.volume = 0;

    return video;
}

function getThumbnailSelector(brandingLocation: BrandingLocation): string {
    switch (brandingLocation) {
        case BrandingLocation.Related:
            return "ytd-thumbnail:not([hidden]) img, ytd-playlist-thumbnail yt-image:not(.blurred-image) img";
        case BrandingLocation.Endcards:
            return ".ytp-ce-covering-image";
        case BrandingLocation.Autoplay:
            return "div.ytp-autonav-endscreen-upnext-thumbnail";
        case BrandingLocation.EndRecommendations:
            return "div.ytp-videowall-still-image";
        case BrandingLocation.Watch:
            return ".ytp-cued-thumbnail-overlay-image";
        default:
            throw new Error("Invalid branding location");
    }
}

function getThumbnailBox(image: HTMLElement, brandingLocation: BrandingLocation): HTMLElement {
    switch (brandingLocation) {
        case BrandingLocation.Related:
            return image.closest("ytd-thumbnail:not([hidden]), ytd-playlist-thumbnail") as HTMLElement;
        case BrandingLocation.Autoplay:
            return image;
        default:
            return image.parentElement!;
    }
}

export async function replaceThumbnail(element: HTMLElement, videoID: VideoID, brandingLocation: BrandingLocation,
        showCustomBranding: boolean, timestamp?: number): Promise<boolean> {
    const image = element.querySelector(getThumbnailSelector(brandingLocation)) as HTMLImageElement;
    const box = getThumbnailBox(image, brandingLocation);

    if (!showCustomBranding || !Config.config!.extensionEnabled 
            || shouldReplaceThumbnailsFastCheck(videoID) === false) {
        resetToShowOriginalThumbnail(image, brandingLocation);

        if (Config.config!.extensionEnabled && await shouldReplaceThumbnails(videoID)) {
            // Still check if the thumbnail is supposed to be changed or not
            const thumbnail = await getVideoThumbnailIncludingUnsubmitted(videoID, brandingLocation);
            return !!thumbnail && !thumbnail.original;
        } else {
            return false;
        }
    }

    if (image && box) {
        let objectWidth = box.offsetWidth;
        let objectHeight = box.offsetHeight;
        if (objectWidth === 0 || objectHeight === 0) {
            const style = window.getComputedStyle(box);
            objectWidth = parseInt(style.getPropertyValue("width").replace("px", ""), 10);
            objectHeight = parseInt(style.getPropertyValue("height").replace("px", ""), 10);

            if (objectWidth === 0) {
                try {
                    await waitFor(() => box.offsetWidth > 0 && box.offsetHeight > 0);
                } catch (e) {
                    // No need to render this thumbnail since it is hidden
                    return false;
                }
            }
        }

        const width = objectWidth * window.devicePixelRatio;
        const height = objectHeight * window.devicePixelRatio;

        // TODO: Add option not to hide all thumbnails by default
        image.style.display = "none";
        image.classList.remove("cb-visible");

        // Trigger a fetch to start, and display the original thumbnail if necessary
        getVideoThumbnailIncludingUnsubmitted(videoID, brandingLocation).then(async (thumbnail) => {
            if (!thumbnail || thumbnail.original) {
                if (!thumbnail && await getThumbnailFallbackOption(videoID) === ThumbnailFallbackOption.Blank) {
                    resetToBlankThumbnail(image);
                } else {
                    resetToShowOriginalThumbnail(image, brandingLocation);
                }
            }
        }).catch(logError);

        const existingImageElement = image.parentElement?.querySelector(".cbCustomThumbnailCanvas") as HTMLImageElement | null;

        try {
            const thumbnail = await createThumbnailImageElement(existingImageElement, videoID, width, height, brandingLocation, timestamp ?? null, false, async () => {
                return brandingLocation === BrandingLocation.Watch ? getVideoID() === videoID 
                    : await extractVideoIDFromElement(element, brandingLocation) === videoID;
            }, (thumbnail) => {
                thumbnail!.style.removeProperty("display");

                if (brandingLocation === BrandingLocation.Related) {
                    box.setAttribute("loaded", "");
                }

                countThumbnailReplacement(videoID);
            }, () => resetToShowOriginalThumbnail(image, brandingLocation));
    
            if (!thumbnail) {
                // Hiding handled by already above then check
                return false;
            }

            // Waiting until now so that innertube has time to fetch data
            if (!await shouldReplaceThumbnails(videoID)) {
                resetToShowOriginalThumbnail(image, brandingLocation);

                return false;
            }

            image.style.display = "none";
            image.classList.remove("cb-visible");
            thumbnail.classList.add("style-scope");
            thumbnail.classList.add("ytd-img-shadow");
            thumbnail.classList.add("cbCustomThumbnailCanvas");
            thumbnail.style.removeProperty("display");

            if (brandingLocation === BrandingLocation.EndRecommendations) {
                thumbnail.classList.add("ytp-videowall-still-image");
            } else if (brandingLocation === BrandingLocation.Autoplay) {
                thumbnail.classList.add("ytp-autonav-endscreen-upnext-thumbnail");
            }

            thumbnail.style.height = "100%";
            if (brandingLocation === BrandingLocation.Autoplay) {
                // For autoplay, the thumbnail is placed inside the image div, which has the image as the background image
                // This is because hiding the entire div would hide the video duration
                image.prepend(thumbnail);
                image.style.removeProperty("display");
                image.classList.add("cb-visible");
            } else {
                image.parentElement?.appendChild?.(thumbnail);
            }
        } catch (e) {
            logError(e);

            resetToShowOriginalThumbnail(image, brandingLocation);
            return false;
        }
    }

    return !!image;
}

function resetToShowOriginalThumbnail(image: HTMLImageElement, brandingLocation: BrandingLocation) {
    image.classList.add("cb-visible");
    image.style.removeProperty("display");

    if (brandingLocation === BrandingLocation.Autoplay
            || !!image.closest("ytd-grid-playlist-renderer")) {
        hideCanvas(image);
    }
}

function resetToBlankThumbnail(image: HTMLImageElement) {
    image.classList.remove("cb-visible");
    image.style.setProperty("display", "none", "important");

    hideCanvas(image);
}

function hideCanvas(image: HTMLElement) {
    const canvas = image.parentElement?.querySelector(".cbCustomThumbnailCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.style.display = "none";
    }
}

export function setupPreRenderedThumbnail(videoID: VideoID, timestamp: number, blob: Blob) {
    const videoCache = setupCache(videoID);
    const videoObject: RenderedThumbnailVideo = {
        video: null,
        width: 1280, // Can use arbitrary values, since the blob's image bitmap is actually used to render
        height: 720,
        rendered: true,
        onReady: [],
        timestamp,
        blob,
        fromThumbnailCache: true
    }
    videoCache.video.push(videoObject);

    stopRendering(videoID, "Pre-rendered thumbnail");
    
    const unrendered = videoCache.video.filter(v => v.timestamp === timestamp && !v.rendered);
    if (unrendered.length > 0) {
        for (const video of unrendered) {
            (video as RenderedThumbnailVideo).blob = blob;
            video.rendered = true;

            for (const callback of video.onReady) {
                callback(video as RenderedThumbnailVideo);
            }
        }
    }

    for (const failure of videoCache.failures) {
        if (failure.timestamp === timestamp) {
            for (const callback of failure.onReady) {
                callback(videoObject);
            }
        }
    }

    videoCache.failures = videoCache.failures.filter(f => f.timestamp !== timestamp);
}

export function isCachedThumbnailLoaded(videoID: VideoID, timestamp: number): boolean {
    const videoCache = getFromCache(videoID);
    return videoCache?.video?.some(v => v.timestamp === timestamp && v.rendered && v.fromThumbnailCache) ?? false;
}