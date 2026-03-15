/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { BaseText } from "@components/BaseText";
import { Card } from "@components/Card";
import ErrorBoundary from "@components/ErrorBoundary";
import { EquicordDevs } from "@utils/constants";
import { classNameFactory } from "@utils/css";
import { Logger } from "@utils/Logger";
import { CloseButton, ModalContent, ModalHeader, ModalProps, ModalRoot, ModalSize, openModal } from "@utils/modal";
import definePlugin, { PluginNative } from "@utils/types";
import { Message, MessageAttachment } from "@vencord/discord-types";
import { React, useEffect, useMemo, useState } from "@webpack/common";
import { unzip } from "fflate";

const cl = classNameFactory("vc-zip-preview-");
const logger = new Logger("ZipPreview");

const Native = IS_DISCORD_DESKTOP
    ? VencordNative.pluginHelpers.ZipPreview as PluginNative<typeof import("./native")>
    : null;

const MAX_ARCHIVE_SIZE_BYTES = 24 * 1024 * 1024;
const MAX_ENTRY_COUNT = 1_500;
const MAX_TEXT_PREVIEW_BYTES = 220 * 1024;

type LoadState = "idle" | "loading" | "error";
type EntryKind = "text" | "image" | "video" | "audio" | "binary";

interface ZipEntry {
    data: Uint8Array;
    fullPath: string;
    kind: EntryKind;
    name: string;
    size: number;
}

interface ZipArchive {
    entries: ZipEntry[];
    totalSize: number;
}

const pendingArchives = new Map<string, Promise<ZipArchive>>();

const textExtensions = new Set([
    "txt", "md", "json", "js", "jsx", "ts", "tsx", "css", "scss", "less",
    "html", "xml", "yaml", "yml", "toml", "ini", "log", "csv", "py", "go",
    "java", "kt", "rs", "c", "cpp", "h", "hpp", "sh", "ps1", "sql"
]);
const imageExtensions = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "svg"]);
const videoExtensions = new Set(["mp4", "webm", "mov", "mkv", "avi"]);
const audioExtensions = new Set(["mp3", "wav", "ogg", "flac", "m4a", "opus", "aac"]);

const fileExtension = (fileName: string) => fileName.split(".").at(-1)?.toLowerCase() ?? "";
const archiveCacheKey = (attachment: MessageAttachment) => `${attachment.id}:${attachment.url}`;
const isZipAttachment = (attachment: MessageAttachment) =>
    attachment.filename.toLowerCase().endsWith(".zip") ||
    attachment.content_type?.toLowerCase().includes("zip") === true;

function formatBytes(bytes: number) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function detectEntryKind(path: string): EntryKind {
    const ext = fileExtension(path);
    if (textExtensions.has(ext)) return "text";
    if (imageExtensions.has(ext)) return "image";
    if (videoExtensions.has(ext)) return "video";
    if (audioExtensions.has(ext)) return "audio";
    return "binary";
}

function mediaMimeType(entry: ZipEntry) {
    const ext = fileExtension(entry.name);

    if (entry.kind === "image") {
        if (ext === "jpg") return "image/jpeg";
        if (ext === "svg") return "image/svg+xml";
        return `image/${ext || "png"}`;
    }

    if (entry.kind === "audio") {
        if (ext === "m4a") return "audio/mp4";
        return `audio/${ext || "mpeg"}`;
    }

    if (entry.kind === "video") {
        if (ext === "mov") return "video/quicktime";
        return `video/${ext || "mp4"}`;
    }

    return "application/octet-stream";
}

function toBlobBuffer(data: Uint8Array) {
    const buffer = new ArrayBuffer(data.byteLength);
    new Uint8Array(buffer).set(data);
    return buffer;
}

async function fetchZipBuffer(url: string): Promise<ArrayBuffer> {
    if (Native) {
        const nativeResponse = await Native.fetchFile(url);
        if (!nativeResponse.ok) {
            throw new Error(`Failed to fetch zip (${nativeResponse.status} ${nativeResponse.statusText})`);
        }

        return nativeResponse.data;
    }

    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch zip (${response.status} ${response.statusText})`);
    }

    return response.arrayBuffer();
}

function inflateZip(buffer: ArrayBuffer): Promise<Record<string, Uint8Array>> {
    return new Promise((resolve, reject) => {
        unzip(new Uint8Array(buffer), (error, data) => {
            if (error) {
                reject(error);
                return;
            }

            resolve(data as Record<string, Uint8Array>);
        });
    });
}

async function loadArchive(attachment: MessageAttachment) {
    if (attachment.size > MAX_ARCHIVE_SIZE_BYTES) {
        throw new Error(
            `Zip is too large to preview (${formatBytes(attachment.size)} / max ${formatBytes(MAX_ARCHIVE_SIZE_BYTES)}).`
        );
    }

    const key = archiveCacheKey(attachment);
    const pending = pendingArchives.get(key);
    if (pending) return pending;

    const request = (async () => {
        const zipBuffer = await fetchZipBuffer(attachment.url);
        const inflatedFiles = await inflateZip(zipBuffer);

        const entries = Object.entries(inflatedFiles)
            .filter(([path]) => !path.endsWith("/"))
            .map(([path, data]) => ({
                data,
                fullPath: path,
                kind: detectEntryKind(path),
                name: path.split("/").at(-1) ?? path,
                size: data.byteLength
            }))
            .sort((a, b) => a.fullPath.localeCompare(b.fullPath, "en"));

        if (entries.length > MAX_ENTRY_COUNT) {
            throw new Error(`Archive contains too many files (${entries.length} / max ${MAX_ENTRY_COUNT}).`);
        }

        const totalSize = entries.reduce((acc, entry) => acc + entry.size, 0);
        return { entries, totalSize };
    })().catch(error => {
        pendingArchives.delete(key);
        throw error;
    });

    pendingArchives.set(key, request);
    return request;
}

function triggerDownload(name: string, data: Uint8Array, type = "application/octet-stream") {
    const blob = new Blob([toBlobBuffer(data)], { type });
    const url = URL.createObjectURL(blob);

    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
}

function ZipPreviewModal(
    { archive, attachment, onClose, transitionState }: { archive: ZipArchive; attachment: MessageAttachment; } & ModalProps
) {
    const [query, setQuery] = useState("");
    const [selectedPath, setSelectedPath] = useState(archive.entries[0]?.fullPath ?? "");

    const filteredEntries = useMemo(() => {
        const normalizedQuery = query.trim().toLowerCase();
        if (!normalizedQuery) return archive.entries;
        return archive.entries.filter(entry => entry.fullPath.toLowerCase().includes(normalizedQuery));
    }, [archive.entries, query]);

    useEffect(() => {
        if (!filteredEntries.length) {
            setSelectedPath("");
            return;
        }

        if (!filteredEntries.some(entry => entry.fullPath === selectedPath)) {
            setSelectedPath(filteredEntries[0].fullPath);
        }
    }, [filteredEntries, selectedPath]);

    const selectedEntry = useMemo(
        () => filteredEntries.find(entry => entry.fullPath === selectedPath) ?? filteredEntries[0] ?? null,
        [filteredEntries, selectedPath]
    );

    const mediaUrl = useMemo(() => {
        if (!selectedEntry || (selectedEntry.kind !== "image" && selectedEntry.kind !== "audio" && selectedEntry.kind !== "video")) {
            return null;
        }

        return URL.createObjectURL(new Blob([toBlobBuffer(selectedEntry.data)], { type: mediaMimeType(selectedEntry) }));
    }, [selectedEntry]);

    useEffect(() => {
        if (!mediaUrl) return;
        return () => {
            URL.revokeObjectURL(mediaUrl);
        };
    }, [mediaUrl]);

    const textPreview = useMemo(() => {
        if (!selectedEntry || selectedEntry.kind !== "text" || selectedEntry.size > MAX_TEXT_PREVIEW_BYTES) return null;

        try {
            return new TextDecoder().decode(selectedEntry.data);
        } catch (error) {
            logger.error("Failed to decode text entry.", error);
            return null;
        }
    }, [selectedEntry]);

    return (
        <ModalRoot
            size={ModalSize.LARGE}
            transitionState={transitionState}
            className={cl("modal-root")}
        >
            <ModalHeader className={cl("modal-header")}>
                <div className={cl("modal-title-wrap")}>
                    <div className={cl("modal-title")}>{attachment.filename}</div>
                    <BaseText size="sm" className={cl("modal-subtitle")}>
                        {archive.entries.length} files ・ {formatBytes(archive.totalSize)}
                    </BaseText>
                </div>
                <CloseButton onClick={onClose} />
            </ModalHeader>

            <ModalContent className={cl("modal-content")}>
                <div className={cl("panel-left")}>
                    <input
                        type="text"
                        className={cl("search")}
                        placeholder="Search files..."
                        value={query}
                        onChange={event => setQuery(event.currentTarget.value)}
                    />

                    <div className={cl("entry-list")}>
                        {filteredEntries.map(entry => (
                            <button
                                key={entry.fullPath}
                                className={`${cl("entry-button")} ${selectedEntry?.fullPath === entry.fullPath ? cl("entry-button-active") : ""}`}
                                onClick={() => setSelectedPath(entry.fullPath)}
                                type="button"
                            >
                                <div className={cl("entry-name")}>{entry.fullPath}</div>
                                <div className={cl("entry-size")}>{formatBytes(entry.size)}</div>
                            </button>
                        ))}
                    </div>
                </div>

                <div className={cl("panel-right")}>
                    {!selectedEntry && (
                        <BaseText size="sm" className={cl("status-text")}>
                            No files matched your search.
                        </BaseText>
                    )}

                    {selectedEntry && (
                        <>
                            <div className={cl("preview-header")}>
                                <div className={cl("preview-path")}>{selectedEntry.fullPath}</div>
                                <button
                                    type="button"
                                    className={cl("download-button")}
                                    onClick={() => triggerDownload(selectedEntry.name, selectedEntry.data, mediaMimeType(selectedEntry))}
                                >
                                    Download
                                </button>
                            </div>

                            {selectedEntry.kind === "image" && mediaUrl && (
                                <div className={cl("image-wrap")}>
                                    <img src={mediaUrl} className={cl("image")} alt={selectedEntry.name} />
                                </div>
                            )}

                            {selectedEntry.kind === "audio" && mediaUrl && (
                                <audio src={mediaUrl} className={cl("media-player")} controls />
                            )}

                            {selectedEntry.kind === "video" && mediaUrl && (
                                <video src={mediaUrl} className={cl("media-player")} controls />
                            )}

                            {selectedEntry.kind === "text" && (
                                textPreview != null
                                    ? <pre className={cl("text-preview")}>{textPreview}</pre>
                                    : <BaseText size="sm" className={cl("status-text")}>
                                        This text file is too large to preview inline.
                                    </BaseText>
                            )}

                            {selectedEntry.kind === "binary" && (
                                <BaseText size="sm" className={cl("status-text")}>
                                    Binary file preview is not available. Use Download to inspect this file.
                                </BaseText>
                            )}
                        </>
                    )}
                </div>
            </ModalContent>
        </ModalRoot>
    );
}

const ZipAttachmentCard = ErrorBoundary.wrap(({ attachment }: { attachment: MessageAttachment; }) => {
    const [loadState, setLoadState] = useState<LoadState>("idle");
    const [archive, setArchive] = useState<ZipArchive | null>(null);
    const [errorText, setErrorText] = useState<string | null>(null);

    const openPreview = () => {
        if (archive) {
            openModal(modalProps => <ZipPreviewModal {...modalProps} archive={archive} attachment={attachment} />);
            return;
        }

        setLoadState("loading");
        setErrorText(null);

        void loadArchive(attachment)
            .then(nextArchive => {
                setArchive(nextArchive);
                setLoadState("idle");
                openModal(modalProps => <ZipPreviewModal {...modalProps} archive={nextArchive} attachment={attachment} />);
            })
            .catch(error => {
                logger.error("Failed to load zip archive.", error);
                setLoadState("error");
                setErrorText(error instanceof Error ? error.message : "Failed to load zip archive.");
            });
    };

    return (
        <Card className={cl("card")}>
            <div className={cl("card-main")}>
                <div className={cl("card-title-wrap")}>
                    <div className={cl("card-title")}>{attachment.filename}</div>
                    <BaseText size="sm" className={cl("card-meta")}>
                        {formatBytes(attachment.size)}
                        {archive ? ` ・ ${archive.entries.length} files` : ""}
                    </BaseText>
                </div>

                <button
                    type="button"
                    className={cl("open-button")}
                    onClick={openPreview}
                    disabled={loadState === "loading"}
                >
                    {loadState === "loading" ? "Loading..." : "Browse"}
                </button>
            </div>

            {errorText && (
                <BaseText size="sm" className={cl("error-text")}>
                    {errorText}
                </BaseText>
            )}
        </Card>
    );
}, { noop: true });

export default definePlugin({
    name: "ZipPreview",
    description: "Preview zip attachments with a faster, lightweight browser and clearer UI.",
    authors: [EquicordDevs.TheLazySquid],
    renderMessageAccessory(props) {
        const message = (props as { message?: Message; })?.message;
        if (!message?.attachments?.length) return null;

        const zipAttachments = message.attachments.filter(isZipAttachment);
        if (!zipAttachments.length) return null;

        return (
            <div className={cl("list")}>
                {zipAttachments.map(attachment => (
                    <ZipAttachmentCard
                        key={attachment.id}
                        attachment={attachment}
                    />
                ))}
            </div>
        );
    },
    stop() {
        pendingArchives.clear();
    }
});
