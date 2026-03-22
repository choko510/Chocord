/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { EquicordDevs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin from "@utils/types";
import type { GuildFolder } from "@vencord/discord-types";
import { findByPropsLazy, findStoreLazy } from "@webpack";
import { GuildMemberCountStore, GuildStore, Menu, UserSettingsActionCreators } from "@webpack/common";

const logger = new Logger("SortFolderServers");
const SortedGuildStore = findStoreLazy("SortedGuildStore");
const UserSettingsDelay = findByPropsLazy("INFREQUENT_USER_ACTION");

type SortOrder = "asc" | "desc" | "name";
type FolderId = string | number;

type FolderContextMenuProps = {
    folderId?: FolderId;
    folder?: { folderId?: FolderId; };
    folderNode?: { id?: FolderId; };
    navId?: string;
};

type UpdatableFolderRecord = GuildFolder & {
    id?: FolderId;
    guild_ids?: string[];
    getFolderId?: () => FolderId | null | undefined;
    getId?: () => FolderId | null | undefined;
    getGuildIdsList?: () => string[] | null | undefined;
    getGuildIds?: () => string[] | null | undefined;
    setGuildIdsList?: (guildIds: string[]) => void;
    setGuildIds?: (guildIds: string[]) => void;
};

type GuildFoldersSettingsPayload = {
    folders?: UpdatableFolderRecord[] | Record<string, UpdatableFolderRecord>;
    guildPositions?: string[];
    guildFolders?: {
        folders?: UpdatableFolderRecord[] | Record<string, UpdatableFolderRecord>;
        guildPositions?: string[];
    };
};

function resolveFolderId(props: FolderContextMenuProps): string | null {
    const folderId = props.folderId ?? props.folder?.folderId ?? props.folderNode?.id;
    return folderId == null ? null : String(folderId);
}

function normalizeId(value: unknown): string | null {
    if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
        return String(value);
    }
    return null;
}

function getGuildPositionsFromPayload(payload: GuildFoldersSettingsPayload): string[] | null {
    if (Array.isArray(payload.guildPositions)) return payload.guildPositions;
    if (Array.isArray(payload.guildFolders?.guildPositions)) return payload.guildFolders.guildPositions;
    return null;
}

function compareGuildNames(guildAId: string, guildBId: string) {
    const guildA = GuildStore.getGuild(guildAId);
    const guildB = GuildStore.getGuild(guildBId);

    const nameA = guildA?.name ?? "";
    const nameB = guildB?.name ?? "";
    return nameA.localeCompare(nameB);
}

function sortGuildIds(guildIds: string[], order: SortOrder): string[] {
    return [...guildIds].sort((guildAId, guildBId) => {
        if (order === "name") return compareGuildNames(guildAId, guildBId);

        const memberCountA = GuildMemberCountStore.getMemberCount(guildAId) ?? 0;
        const memberCountB = GuildMemberCountStore.getMemberCount(guildBId) ?? 0;
        const memberDiff = order === "asc" ? memberCountA - memberCountB : memberCountB - memberCountA;
        return memberDiff || compareGuildNames(guildAId, guildBId);
    });
}

function toFolderArray(rawFolders: GuildFoldersSettingsPayload["folders"]): UpdatableFolderRecord[] | null {
    if (Array.isArray(rawFolders)) return rawFolders;
    if (!rawFolders || typeof rawFolders !== "object") return null;

    const mappedFolders = Object.values(rawFolders).filter(folder =>
        folder != null && (typeof folder === "object" || typeof folder === "function")
    ) as UpdatableFolderRecord[];
    return mappedFolders.length > 0 ? mappedFolders : null;
}

function getFoldersFromPayload(payload: GuildFoldersSettingsPayload): UpdatableFolderRecord[] | null {
    return toFolderArray(payload.folders) ?? toFolderArray(payload.guildFolders?.folders);
}

function getFolderEntryId(folder: UpdatableFolderRecord): string | null {
    return normalizeId(folder.folderId)
        ?? normalizeId(folder.id)
        ?? normalizeId(folder.getFolderId?.())
        ?? normalizeId(folder.getId?.());
}

function getFolderEntryGuildIds(folder: UpdatableFolderRecord): string[] | null {
    if (Array.isArray(folder.guildIds)) return folder.guildIds.map(String);
    if (Array.isArray(folder.guild_ids)) return folder.guild_ids.map(String);

    const fromListGetter = folder.getGuildIdsList?.();
    if (Array.isArray(fromListGetter)) return fromListGetter.map(String);

    const fromGetter = folder.getGuildIds?.();
    if (Array.isArray(fromGetter)) return fromGetter.map(String);

    return null;
}

function hasSameGuildIds(guildIdsA: string[] | null, guildIdsB: string[]): boolean {
    if (!guildIdsA || guildIdsA.length !== guildIdsB.length) return false;

    const remainingCounts = new Map<string, number>();
    for (const guildId of guildIdsB) {
        remainingCounts.set(guildId, (remainingCounts.get(guildId) ?? 0) + 1);
    }

    for (const guildId of guildIdsA) {
        const count = remainingCounts.get(guildId);
        if (!count) return false;

        if (count === 1) remainingCounts.delete(guildId);
        else remainingCounts.set(guildId, count - 1);
    }

    return remainingCounts.size === 0;
}

function setFolderEntryGuildIds(folder: UpdatableFolderRecord, sortedGuildIds: string[]): boolean {
    if (typeof folder.setGuildIdsList === "function") {
        folder.setGuildIdsList([...sortedGuildIds]);
        return true;
    }

    if (typeof folder.setGuildIds === "function") {
        folder.setGuildIds([...sortedGuildIds]);
        return true;
    }

    if (Array.isArray(folder.guildIds)) {
        folder.guildIds = [...sortedGuildIds];
        return true;
    }

    if (Array.isArray(folder.guild_ids)) {
        folder.guild_ids = [...sortedGuildIds];
        return true;
    }

    folder.guildIds = [...sortedGuildIds];
    return true;
}

function getFolderFromStore(folderId: string) {
    const folderByStringId = SortedGuildStore?.getGuildFolderById?.(folderId);
    if (folderByStringId) return folderByStringId;

    const numericFolderId = Number(folderId);
    if (!Number.isFinite(numericFolderId)) return null;
    return SortedGuildStore?.getGuildFolderById?.(numericFolderId);
}

function getCurrentFolderGuildIds(folderId: string): string[] | null {
    const folder = getFolderFromStore(folderId);
    if (!folder || !Array.isArray(folder.guildIds)) return null;

    const guildIds = folder.guildIds.map(String);
    return guildIds.length > 1 ? guildIds : null;
}

function findTargetFolder(
    folders: UpdatableFolderRecord[],
    folderId: string,
    originalGuildIds: string[]
): UpdatableFolderRecord | null {
    return folders.find(folder => getFolderEntryId(folder) === folderId)
        ?? folders.find(folder => hasSameGuildIds(getFolderEntryGuildIds(folder), originalGuildIds))
        ?? null;
}

function getPayloadLogContext(folders: UpdatableFolderRecord[]) {
    return {
        folderCount: folders.length,
        availableFolderIds: folders
            .map(getFolderEntryId)
            .filter((id): id is string => id != null)
            .slice(0, 10),
        folderGuildIdPreview: folders
            .slice(0, 5)
            .map(folder => getFolderEntryGuildIds(folder)?.slice(0, 5) ?? [])
    };
}

function reorderGuildPositions(guildPositions: string[], sortedGuildIds: string[]): boolean {
    const sortedGuildIdSet = new Set(sortedGuildIds);
    const presentFolderGuildIds = guildPositions
        .map(String)
        .filter(guildId => sortedGuildIdSet.has(guildId));
    if (presentFolderGuildIds.length < 2) return false;

    const presentFolderGuildIdSet = new Set(presentFolderGuildIds);
    const sortedPresentFolderGuildIds = sortedGuildIds.filter(guildId => presentFolderGuildIdSet.has(guildId));
    if (sortedPresentFolderGuildIds.length !== presentFolderGuildIds.length) return false;

    let changed = false;
    let sortedGuildIdIndex = 0;
    for (let index = 0; index < guildPositions.length; index++) {
        const guildId = String(guildPositions[index]);
        if (!presentFolderGuildIdSet.has(guildId)) continue;

        const nextGuildId = sortedPresentFolderGuildIds[sortedGuildIdIndex++];
        if (guildPositions[index] !== nextGuildId) {
            guildPositions[index] = nextGuildId;
            changed = true;
        }
    }

    return changed;
}

function sortFolder(folderId: string, order: SortOrder) {
    const preloadedSettings = UserSettingsActionCreators?.PreloadedUserSettingsActionCreators;
    if (!preloadedSettings?.updateAsync) {
        logger.warn("Unable to sort folder because PreloadedUserSettingsActionCreators.updateAsync is unavailable.");
        return;
    }

    const currentGuildIds = getCurrentFolderGuildIds(folderId);
    if (!currentGuildIds) return;

    const sortedGuildIds = sortGuildIds(currentGuildIds, order);
    const hasChanges = sortedGuildIds.some((guildId, index) => guildId !== currentGuildIds[index]);
    if (!hasChanges) return;

    preloadedSettings.updateAsync("guildFolders", (payload: GuildFoldersSettingsPayload) => {
        const folders = getFoldersFromPayload(payload);
        if (!folders) {
            logger.warn("Failed to sort folder: guildFolders payload does not contain a folders array.");
            return false;
        }

        const targetFolder = findTargetFolder(folders, folderId, currentGuildIds);
        if (!targetFolder) {
            logger.warn(`Failed to sort folder: folder ${folderId} was not found in guildFolders payload.`, getPayloadLogContext(folders));
            return false;
        }

        if (!setFolderEntryGuildIds(targetFolder, sortedGuildIds)) {
            logger.warn(`Failed to sort folder: unable to write sorted guild IDs for folder ${folderId}.`);
            return false;
        }

        const guildPositions = getGuildPositionsFromPayload(payload);
        if (guildPositions) reorderGuildPositions(guildPositions, sortedGuildIds);
        return true;
    }, UserSettingsDelay?.INFREQUENT_USER_ACTION ?? 1000);
}

const contextMenuPatch: NavContextMenuPatchCallback = (children, props: FolderContextMenuProps) => {
    const folderId = resolveFolderId(props);
    if (!folderId) return;

    const targetGroup = findGroupChildrenByChildId(
        ["hide-folder", "mark-folder-read", "folder-settings"],
        children,
        true
    ) ?? children;

    targetGroup.push(
        <Menu.MenuItem
            id={`vc-sort-folder-${folderId}`}
            label="フォルダを並び替える"
        >
            <Menu.MenuItem
                id={`vc-sort-folder-asc-${folderId}`}
                label="メンバー数 (昇順)"
                action={() => sortFolder(folderId, "asc")}
            />
            <Menu.MenuItem
                id={`vc-sort-folder-desc-${folderId}`}
                label="メンバー数 (降順)"
                action={() => sortFolder(folderId, "desc")}
            />
            <Menu.MenuItem
                id={`vc-sort-folder-name-${folderId}`}
                label="サーバー名"
                action={() => sortFolder(folderId, "name")}
            />
        </Menu.MenuItem>
    );
};

export default definePlugin({
    name: "SortFolderServers",
    description: "フォルダを右クリックしたときにサーバーをメンバー数などで並び替えられるようにします。",
    authors: [EquicordDevs.bep],
    tags: ["guild", "folder", "sort"],
    contextMenus: {
        "guild-context": contextMenuPatch
    }
});
