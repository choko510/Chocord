/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings, Settings } from "@api/Settings";
import { EquicordDevs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { DraftType, FluxDispatcher, OverridePremiumTypeStore } from "@webpack/common";

const logger = new Logger("ImageCompressor");

const CompressionStrategy = {
    NONE: "none",
    ONCE: "once",
    AUTO: "auto"
} as const;
type CompressionStrategy = typeof CompressionStrategy[keyof typeof CompressionStrategy];

const OutputFormat = {
    WEBP: "image/webp",
    JPEG: "image/jpeg",
    PNG: "image/png"
} as const;
type OutputFormat = typeof OutputFormat[keyof typeof OutputFormat];

const BYTES_PER_MIB = 1024 * 1024;
const MIN_AUTO_QUALITY = 0.1;
const MAX_AUTO_PASSES = 8;
const validOutputFormats = new Set<OutputFormat>(Object.values(OutputFormat));
const likelyImageExtensions = new Set(["png", "jpg", "jpeg", "webp", "bmp", "avif"]);
const handledFiles = new WeakSet<File>();

const settings = definePluginSettings({
    strategy: {
        type: OptionType.SELECT,
        description: "When to compress image uploads.",
        options: [
            { label: "Smart size limit", value: CompressionStrategy.AUTO, default: true },
            { label: "Always compress", value: CompressionStrategy.ONCE },
            { label: "Never compress", value: CompressionStrategy.NONE },
        ]
    },
    outputFormat: {
        type: OptionType.SELECT,
        description: "Output image format.",
        options: [
            { label: "WebP", value: OutputFormat.WEBP, default: true },
            { label: "JPEG", value: OutputFormat.JPEG },
            { label: "PNG", value: OutputFormat.PNG },
        ]
    },
    quality: {
        type: OptionType.SLIDER,
        description: "Default quality for lossy formats.",
        markers: [0.1, 0.25, 0.4, 0.55, 0.7, 0.85, 1],
        default: 0.9,
        stickToMarkers: false,
    },
    maxDimension: {
        type: OptionType.SLIDER,
        description: "Maximum width/height (pixels) after scaling.",
        markers: [512, 1024, 2048, 4096, 8192],
        default: 4096,
        stickToMarkers: false,
    },
    targetSizeMB: {
        type: OptionType.SLIDER,
        description: "Target size used by smart mode.",
        markers: [1, 2, 5, 8, 10, 20, 50, 100, 250],
        default: 10,
        stickToMarkers: false,
    }
});

interface UploadAttachmentAddFilesAction {
    type: "UPLOAD_ATTACHMENT_ADD_FILES";
    channelId?: string;
    draftType?: number;
    files?: unknown;
    uploads?: unknown;
    items?: unknown;
    [key: string]: unknown;
}

interface UploadObjectWithFile {
    file: File;
    [key: string]: unknown;
}

interface UploadObjectWithItemFile {
    item: {
        file: File;
        [key: string]: unknown;
    };
    [key: string]: unknown;
}

interface UploadFileRecord {
    file: File;
    original: unknown;
}

interface CompressionOptions {
    format: OutputFormat;
    maxDimension: number;
    quality: number;
    strategy: CompressionStrategy;
    targetBytes: number;
}

interface PreparedImageEncoding {
    canvas: HTMLCanvasElement;
    format: OutputFormat;
    outputName: string;
}

let uploadAddFilesInterceptor: ((event: unknown) => void) | null = null;

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function roundQuality(value: number): number {
    return Math.round(clamp(value, MIN_AUTO_QUALITY, 1) * 100) / 100;
}

function getStrategy(): CompressionStrategy {
    return settings.store.strategy as CompressionStrategy;
}

function getCompressionOptions(): CompressionOptions {
    const formatFromSettings = settings.store.outputFormat as OutputFormat;
    const quality = Number(settings.store.quality);
    const maxDimension = Number(settings.store.maxDimension);
    const targetSizeMB = Number(settings.store.targetSizeMB);

    return {
        format: validOutputFormats.has(formatFromSettings) ? formatFromSettings : OutputFormat.WEBP,
        maxDimension: clamp(Number.isFinite(maxDimension) ? maxDimension : 4096, 32, 16384),
        quality: clamp(Number.isFinite(quality) ? quality : 0.9, MIN_AUTO_QUALITY, 1),
        strategy: getStrategy(),
        targetBytes: Math.max(0.5, Number.isFinite(targetSizeMB) ? targetSizeMB : 10) * BYTES_PER_MIB
    };
}

function getUploadLimitBytes(): number {
    const premiumType = OverridePremiumTypeStore.getState().premiumTypeActual ?? 0;
    return premiumType === 2 ? 1000 * BYTES_PER_MIB : 10 * BYTES_PER_MIB;
}

function isFileUploadInterceptorEnabled(): boolean {
    const fileUploadSettings = Settings.plugins.FileUpload as {
        enabled?: boolean;
        interceptDiscordUpload?: boolean;
    } | undefined;

    return Boolean(fileUploadSettings?.enabled && fileUploadSettings.interceptDiscordUpload);
}

function isUploadAction(value: unknown): value is UploadAttachmentAddFilesAction {
    return typeof value === "object"
        && value !== null
        && "type" in value
        && (value as { type?: unknown; }).type === "UPLOAD_ATTACHMENT_ADD_FILES";
}

function isUploadObjectWithFile(value: unknown): value is UploadObjectWithFile {
    return typeof value === "object"
        && value !== null
        && "file" in value
        && (value as { file?: unknown; }).file instanceof File;
}

function isUploadObjectWithItemFile(value: unknown): value is UploadObjectWithItemFile {
    if (typeof value !== "object" || value === null || !("item" in value)) {
        return false;
    }

    const { item } = (value as { item?: unknown; });
    return typeof item === "object"
        && item !== null
        && "file" in item
        && (item as { file?: unknown; }).file instanceof File;
}

function extractUploadFiles(value: unknown): UploadFileRecord[] {
    const items = Array.isArray(value)
        ? value
        : (
            value
            && typeof value === "object"
            && Symbol.iterator in value
            && typeof (value as { [Symbol.iterator]?: unknown; })[Symbol.iterator] === "function"
            ? Array.from(value as Iterable<unknown>)
            : []
        );

    if (!items.length) {
        return [];
    }

    const records: UploadFileRecord[] = [];
    for (const entry of items) {
        if (entry instanceof File) {
            records.push({
                file: entry,
                original: entry
            });
            continue;
        }

        if (isUploadObjectWithFile(entry)) {
            records.push({
                file: entry.file,
                original: entry
            });
            continue;
        }

        if (isUploadObjectWithItemFile(entry)) {
            records.push({
                file: entry.item.file,
                original: entry
            });
        }
    }

    return records;
}

function collectUploadFiles(payload: UploadAttachmentAddFilesAction): UploadFileRecord[] {
    const unique = new Map<File, UploadFileRecord>();
    const records = [
        ...extractUploadFiles(payload.files),
        ...extractUploadFiles(payload.uploads),
        ...extractUploadFiles(payload.items)
    ];

    for (const record of records) {
        if (!unique.has(record.file)) {
            unique.set(record.file, record);
        }
    }

    return [...unique.values()];
}

function replaceFileInUploadEntry(original: unknown, file: File): unknown {
    if (original instanceof File) {
        return file;
    }

    if (isUploadObjectWithFile(original)) {
        return {
            ...original,
            file
        };
    }

    if (isUploadObjectWithItemFile(original)) {
        return {
            ...original,
            item: {
                ...original.item,
                file
            }
        };
    }

    return file;
}

function getFileExtension(fileName: string): string {
    const lastDot = fileName.lastIndexOf(".");
    return lastDot === -1 ? "" : fileName.slice(lastDot + 1).toLowerCase();
}

function isLikelyImage(file: File): boolean {
    if (file.type.toLowerCase().startsWith("image/")) {
        return true;
    }

    const extension = getFileExtension(file.name);
    return likelyImageExtensions.has(extension);
}

function isCanvasUnsafeImage(file: File): boolean {
    const mime = file.type.toLowerCase();
    const extension = getFileExtension(file.name);
    return mime === "image/gif"
        || mime === "image/svg+xml"
        || extension === "gif"
        || extension === "svg";
}

function getOutputExtension(format: OutputFormat): string {
    switch (format) {
        case OutputFormat.JPEG:
            return "jpg";
        case OutputFormat.PNG:
            return "png";
        case OutputFormat.WEBP:
        default:
            return "webp";
    }
}

function replaceFileExtension(fileName: string, extension: string): string {
    const normalized = fileName.replace(/\.+$/, "");
    const lastDot = normalized.lastIndexOf(".");
    if (lastDot === -1) {
        return `${normalized}.${extension}`;
    }

    return `${normalized.slice(0, lastDot)}.${extension}`;
}

function decodeImage(url: string, fileName: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error(`Could not decode image: ${fileName}`));
        image.src = url;
    });
}

async function createPreparedImage(file: File, maxDimension: number, format: OutputFormat): Promise<PreparedImageEncoding> {
    const imageUrl = URL.createObjectURL(file);
    try {
        const image = await decodeImage(imageUrl, file.name);

        const sourceWidth = image.naturalWidth || image.width;
        const sourceHeight = image.naturalHeight || image.height;
        if (!sourceWidth || !sourceHeight) {
            throw new Error(`Invalid image dimensions for ${file.name}`);
        }

        const scale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight));
        const width = Math.max(1, Math.round(sourceWidth * scale));
        const height = Math.max(1, Math.round(sourceHeight * scale));

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;

        const context = canvas.getContext("2d");
        if (!context) {
            throw new Error("Could not get 2D canvas context");
        }

        if (format === OutputFormat.JPEG) {
            context.fillStyle = "#FFFFFF";
            context.fillRect(0, 0, width, height);
        }

        context.drawImage(image, 0, 0, width, height);
        return {
            canvas,
            format,
            outputName: replaceFileExtension(file.name, getOutputExtension(format))
        };
    } finally {
        URL.revokeObjectURL(imageUrl);
    }
}

function encodePreparedImage(prepared: PreparedImageEncoding, quality: number): Promise<File> {
    return new Promise((resolve, reject) => {
        const encodingQuality = prepared.format === OutputFormat.PNG ? undefined : clamp(quality, MIN_AUTO_QUALITY, 1);
        prepared.canvas.toBlob(blob => {
            if (!blob) {
                reject(new Error(`Canvas encoding failed for ${prepared.outputName}`));
                return;
            }

            resolve(new File([blob], prepared.outputName, {
                type: prepared.format,
                lastModified: Date.now()
            }));
        }, prepared.format, encodingQuality);
    });
}

function createQualityEncoder(prepared: PreparedImageEncoding): (quality: number) => Promise<File> {
    const cache = new Map<number, Promise<File>>();

    return quality => {
        const normalizedQuality = roundQuality(quality);
        const cached = cache.get(normalizedQuality);
        if (cached) {
            return cached;
        }

        const encoded = encodePreparedImage(prepared, normalizedQuality);
        cache.set(normalizedQuality, encoded);
        return encoded;
    };
}

async function compressOnce(file: File, options: CompressionOptions): Promise<File> {
    const prepared = await createPreparedImage(file, options.maxDimension, options.format);
    const encode = createQualityEncoder(prepared);
    return encode(options.quality);
}

async function compressWithReducedDimensions(file: File, options: CompressionOptions, currentBest: File): Promise<File> {
    if (currentBest.size <= options.targetBytes) {
        return currentBest;
    }

    const scaleEstimate = Math.sqrt(options.targetBytes / currentBest.size);
    const reducedDimension = Math.floor(options.maxDimension * clamp(scaleEstimate * 0.97, 0.5, 0.92));
    const nextMaxDimension = Math.max(512, reducedDimension);

    if (nextMaxDimension >= options.maxDimension) {
        return currentBest;
    }

    const prepared = await createPreparedImage(file, nextMaxDimension, options.format);
    const encode = createQualityEncoder(prepared);
    let best = currentBest;

    const highCandidate = await encode(options.quality);
    if (highCandidate.size < best.size) {
        best = highCandidate;
    }

    if (options.format !== OutputFormat.PNG && highCandidate.size > options.targetBytes) {
        const lowCandidate = await encode(MIN_AUTO_QUALITY);
        if (lowCandidate.size < best.size) {
            best = lowCandidate;
        }
    }

    return best;
}

async function compressAuto(file: File, options: CompressionOptions): Promise<File> {
    const highQuality = roundQuality(options.quality);
    const prepared = await createPreparedImage(file, options.maxDimension, options.format);
    const encode = createQualityEncoder(prepared);

    let bestUnderTarget: File | null = null;
    let smallestResult: File | null = null;

    const registerResult = (candidate: File) => {
        if (!smallestResult || candidate.size < smallestResult.size) {
            smallestResult = candidate;
        }

        if (candidate.size <= options.targetBytes && (!bestUnderTarget || candidate.size > bestUnderTarget.size)) {
            bestUnderTarget = candidate;
        }
    };

    const highResult = await encode(highQuality);
    registerResult(highResult);

    if (options.format === OutputFormat.PNG) {
        return compressWithReducedDimensions(file, options, highResult);
    }

    if (highResult.size <= options.targetBytes) {
        return highResult;
    }

    const lowQuality = MIN_AUTO_QUALITY;
    const lowResult = await encode(lowQuality);
    registerResult(lowResult);

    if (lowResult.size > options.targetBytes) {
        return compressWithReducedDimensions(file, options, smallestResult ?? lowResult);
    }

    let lowerBound = lowQuality;
    let upperBound = highQuality;

    for (let pass = 0; pass < MAX_AUTO_PASSES; pass++) {
        if (upperBound - lowerBound < 0.01) {
            break;
        }

        const probeQuality = roundQuality((lowerBound + upperBound) / 2);
        if (probeQuality <= lowerBound || probeQuality >= upperBound) {
            break;
        }

        const probeResult = await encode(probeQuality);
        registerResult(probeResult);

        const closeEnough = Math.abs(probeResult.size - options.targetBytes) <= options.targetBytes * 0.03;

        if (probeResult.size <= options.targetBytes) {
            lowerBound = probeQuality;
            if (closeEnough) break;
        } else {
            upperBound = probeQuality;
        }
    }

    const bestResult = bestUnderTarget ?? smallestResult ?? highResult;
    if (bestResult.size > options.targetBytes) {
        return compressWithReducedDimensions(file, options, bestResult);
    }

    return bestResult;
}

function shouldCompress(file: File, options: CompressionOptions, uploadLimitBytes: number): boolean {
    if (handledFiles.has(file)) return false;
    if (!isLikelyImage(file)) return false;
    if (isCanvasUnsafeImage(file)) return false;
    if (options.strategy === CompressionStrategy.NONE) return false;
    if (options.strategy === CompressionStrategy.ONCE) return true;
    return file.size > options.targetBytes || file.size > uploadLimitBytes;
}

async function compressFile(file: File, options: CompressionOptions): Promise<File> {
    const compressed = options.strategy === CompressionStrategy.AUTO
        ? await compressAuto(file, options)
        : await compressOnce(file, options);

    return compressed.size < file.size ? compressed : file;
}

async function compressAndRedispatch(payload: UploadAttachmentAddFilesAction, records: UploadFileRecord[]): Promise<void> {
    const options = getCompressionOptions();
    const uploadLimitBytes = getUploadLimitBytes();
    const remappedEntries: unknown[] = [];

    for (const record of records) {
        let resultFile = record.file;
        if (shouldCompress(record.file, options, uploadLimitBytes)) {
            try {
                resultFile = await compressFile(record.file, options);
            } catch (error) {
                logger.warn(`Failed to compress ${record.file.name}`, error);
                resultFile = record.file;
            }
        }

        handledFiles.add(record.file);
        handledFiles.add(resultFile);
        remappedEntries.push(replaceFileInUploadEntry(record.original, resultFile));
    }

    if (!remappedEntries.length) return;

    const action: UploadAttachmentAddFilesAction = {
        type: "UPLOAD_ATTACHMENT_ADD_FILES",
        channelId: payload.channelId,
        draftType: payload.draftType,
        files: remappedEntries
    };

    await FluxDispatcher.dispatch(action);
}

async function dispatchOriginalEntries(payload: UploadAttachmentAddFilesAction, records: UploadFileRecord[]): Promise<void> {
    const originalEntries = records.map(record => {
        handledFiles.add(record.file);
        return replaceFileInUploadEntry(record.original, record.file);
    });

    if (!originalEntries.length) return;

    await FluxDispatcher.dispatch({
        type: "UPLOAD_ATTACHMENT_ADD_FILES",
        channelId: payload.channelId,
        draftType: payload.draftType,
        files: originalEntries
    });
}

function interceptUploadAddFiles(event: unknown): void {
    if (!isUploadAction(event)) return;
    if (event.draftType !== DraftType.ChannelMessage) return;
    if (isFileUploadInterceptorEnabled()) return;
    if (getStrategy() === CompressionStrategy.NONE) return;

    const records = collectUploadFiles(event);
    if (!records.length) return;

    const options = getCompressionOptions();
    const uploadLimitBytes = getUploadLimitBytes();
    const hasCompressibleImage = records.some(record => shouldCompress(record.file, options, uploadLimitBytes));
    if (!hasCompressibleImage) return;

    event.files = [];
    event.uploads = [];
    event.items = [];
    void compressAndRedispatch(event, records).catch(error => {
        logger.error("Image compression pipeline failed. Falling back to original upload.", error);
        void dispatchOriginalEntries(event, records).catch(dispatchError => {
            logger.error("Fallback upload dispatch failed.", dispatchError);
        });
    });
}

export default definePlugin({
    name: "ImageCompressor",
    description: "Automatically compresses large image uploads before sending.",
    authors: [EquicordDevs.niko, {
        name: "Small-Ku",
        id: 0n
    }],
    settings,
    patches: [
        {
            find: "#{intl::tRuxk9::raw}",
            replacement: {
                match: /(\.limits\.fileSize.{0,50})Array\.from\((\i)\)\.some/,
                replace: "$1$self.shouldBypassDiscordUploadSizeCheck($2)?false:Array.from($2).some"
            }
        }
    ],
    start() {
        if (uploadAddFilesInterceptor) return;
        uploadAddFilesInterceptor = event => interceptUploadAddFiles(event);
        FluxDispatcher.addInterceptor(uploadAddFilesInterceptor);
    },
    stop() {
        if (!uploadAddFilesInterceptor) return;

        const index = FluxDispatcher._interceptors.indexOf(uploadAddFilesInterceptor);
        if (index > -1) {
            FluxDispatcher._interceptors.splice(index, 1);
        }

        uploadAddFilesInterceptor = null;
    },
    shouldBypassDiscordUploadSizeCheck(files: unknown) {
        if (isFileUploadInterceptorEnabled()) return false;

        const options = getCompressionOptions();
        if (options.strategy === CompressionStrategy.NONE) return false;

        const uploadLimitBytes = getUploadLimitBytes();
        return extractUploadFiles(files).some(({ file }) =>
            !handledFiles.has(file)
            && isLikelyImage(file)
            && !isCanvasUnsafeImage(file)
            && file.size > uploadLimitBytes
        );
    }
});
