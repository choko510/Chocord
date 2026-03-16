/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ChannelTabsPlugin from "@equicordplugins/channelTabs";
import { Devs, EquicordDevs } from "@utils/constants";
import definePlugin from "@utils/types";

export default definePlugin({
    ...ChannelTabsPlugin,
    name: "ChannelTabs",
    description: "Group your commonly visited channels in tabs, like a browser",
    authors: [Devs.TheSun, Devs.TheKodeToad, EquicordDevs.keifufu, Devs.Nickyux, EquicordDevs.DiabeloDEV, EquicordDevs.justjxke],
    dependencies: ["ContextMenuAPI"],
    patches: ChannelTabsPlugin.patches
});
