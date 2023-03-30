import * as CompileConfig from "../config.json";

import { VideoID } from "@ajayyy/maze-utils/lib/video";
import { ThumbnailResult, ThumbnailSubmission } from "./thumbnails/thumbnailData";
import { TitleResult, TitleSubmission } from "./titles/titleData";
import { FetchResponse, sendRequestToCustomServer } from "@ajayyy/maze-utils/lib/background-request-proxy";
import { BrandingResult } from "./videoBranding/videoBranding";
import { logError } from "./utils/logger";
import { getHash } from "@ajayyy/maze-utils/lib/hash";
import Config from "./config";
import { generateUserID } from "@ajayyy/maze-utils/lib/setup";
import { BrandingUUID } from "./videoBranding/videoBranding";

interface VideoBrandingCacheRecord extends BrandingResult {
    lastUsed: number;
}

const cache: Record<VideoID, VideoBrandingCacheRecord> = {};
const cacheLimit = 1000;

const activeRequests: Record<VideoID, Promise<Record<VideoID, BrandingResult> | null>> = {};

export async function getVideoThumbnailIncludingUnsubmitted(videoID: VideoID, queryByHash: boolean): Promise<ThumbnailResult | null> {
    const unsubmitted = Config.local!.unsubmitted[videoID]?.thumbnails?.find(t => t.selected);
    if (unsubmitted) {
        return {
            ...unsubmitted,
            votes: 0,
            locked: false,
            UUID: generateUserID() as BrandingUUID
        };
    }

    return (await getVideoBranding(videoID, queryByHash))?.thumbnails[0] ?? null;
}

export async function getVideoTitleIncludingUnsubmitted(videoID: VideoID, queryByHash: boolean): Promise<TitleResult | null> {
    const unsubmitted = Config.local!.unsubmitted[videoID]?.titles?.find(t => t.selected);
    if (unsubmitted) {
        return {
            ...unsubmitted,
            votes: 0,
            locked: false,
            UUID: generateUserID() as BrandingUUID,
            original: false
        };
    }

    return (await getVideoBranding(videoID, queryByHash))?.titles[0] ?? null;
}

export async function getVideoBranding(videoID: VideoID, queryByHash: boolean): Promise<VideoBrandingCacheRecord | null> {
    const cachedValue = cache[videoID];

    const oneHour = 1000 * 60 * 60;
    if (cachedValue?.lastUsed > Date.now() - oneHour) {
        return cachedValue;
    }

    activeRequests[videoID] ??= (async () => {
        let result: Record<VideoID, BrandingResult> | null = null;
        if (queryByHash) {
            const request = await sendRequestToServer("GET", `/api/branding/${(await getHash(videoID, 1)).slice(0, 4)}`);

            if (request.ok || request.status === 404) {
                try {
                    const json = JSON.parse(request.responseText);
                    result = json;
                } catch (e) {
                    logError(`Getting video branding for ${videoID} failed: ${e}`);
                }
            }
        } else {
            const request = await sendRequestToServer("GET", "/api/branding", {
                videoID
            });

            if (request.ok || request.status === 404) {
                try {
                    result = {
                        [videoID]: JSON.parse(request.responseText)
                    };
                } catch (e) {
                    logError(`Getting video branding for ${videoID} failed: ${e}`);
                }
            }
        }

        return result;
    })();

    const results = await activeRequests[videoID];
    delete activeRequests[videoID];

    if (results) {
        for (const [key, result] of Object.entries(results)) {
            cache[key] = {
                titles: result.titles,
                thumbnails: result.thumbnails,
                lastUsed: key === videoID ? Date.now() : 0
            };
        }

        const keys = Object.keys(cache);
        if (keys.length > cacheLimit) {
            const numberToDelete = keys.length - cacheLimit;

            for (let i = 0; i < numberToDelete; i++) {
                const oldestKey = keys.reduce((a, b) => cache[a].lastUsed < cache[b].lastUsed ? a : b);
                delete cache[oldestKey];
            }
        }
    }

    return cache[videoID];
}

export function clearCache(videoID: VideoID) {
    delete cache[videoID];
}

export async function submitVideoBranding(videoID: VideoID, title: TitleSubmission, thumbnail: ThumbnailSubmission): Promise<FetchResponse> {
    const result = await sendRequestToServer("POST", "/api/branding", {
        userID: Config.config!.userID,
        videoID,
        title,
        thumbnail
    });

    clearCache(videoID);
    return result;
}

export function sendRequestToServer(type: string, url: string, data = {}): Promise<FetchResponse> {
    return sendRequestToCustomServer(type, CompileConfig.serverAddress + url, data);
}