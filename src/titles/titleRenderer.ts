import { VideoID } from "@ajayyy/maze-utils/lib/video";
import { getVideoTitleIncludingUnsubmitted } from "../dataFetching";
import { logError } from "../utils/logger";
import { BrandingLocation } from "../videoBranding/videoBranding";

export async function replaceTitle(element: HTMLElement, videoID: VideoID, brandingLocation: BrandingLocation, queryByHash: boolean): Promise<boolean> {
    const originalTitleElement = element.querySelector(`${getTitleSelector(brandingLocation)}:not(.cbCustomTitle)`) as HTMLElement;
    const titleElement = element.querySelector(".cbCustomTitle") as HTMLElement ?? createTitleElement(originalTitleElement, brandingLocation);

    //todo: add an option to not hide title
    titleElement.style.visibility = "hidden";
    originalTitleElement.style.display = "none";

    try {
        const title = (await getVideoTitleIncludingUnsubmitted(videoID, queryByHash))?.title;
        if (title) {
            titleElement.innerText = title;
            titleElement.title = title;
        } else if (originalTitleElement?.textContent) {
            // TODO: Allow customizing this rule
            // innerText is blank when visibility hidden
            const modifiedTitle = toTitleCase(originalTitleElement.textContent.trim());
            titleElement.innerText = modifiedTitle;
            titleElement.title = modifiedTitle;
        } else {
            originalTitleElement.style.removeProperty("display");
        }

        titleElement.style.visibility = "visible";
        return true;
    } catch (e) {
        logError(e);
        originalTitleElement.style.removeProperty("display");

        return false;
    }
}

function getTitleSelector(brandingLocation: BrandingLocation): string {
    switch (brandingLocation) {
        case BrandingLocation.Watch:
            return "yt-formatted-string";
        case BrandingLocation.Related:
            return "#video-title";
        default:
            throw new Error("Invalid branding location");
    }
}

function createTitleElement(originalElement: HTMLElement, brandingLocation: BrandingLocation): HTMLElement {
    const titleElement = brandingLocation === BrandingLocation.Related ? originalElement.cloneNode() as HTMLElement 
        : document.createElement("div");
    titleElement.classList.add("cbCustomTitle");

    originalElement.parentElement?.appendChild(titleElement);
    return titleElement;
}

// https://stackoverflow.com/a/196991
function toTitleCase(str: string): string {
    // TODO: ignore some acronyms like AI, allow customizing
    return str.replace(
        /\w\S*/g,
        (txt) => {
            return txt.charAt(0).toUpperCase() + txt.substring(1).toLowerCase();
        }
    );
}