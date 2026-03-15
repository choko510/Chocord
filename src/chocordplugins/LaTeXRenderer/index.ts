/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { EquicordDevs } from "@utils/constants";
import definePlugin from "@utils/types";
import legacyPluginSource from "file://./LaTeX.plugin.js?trim=false";

import { createBdPluginBridge } from "../_api/bdCompat";

const bridge = createBdPluginBridge("LaTeXRenderer", legacyPluginSource);

export default definePlugin({
    name: "LaTeXRenderer",
    description: "Renders LaTeX equations using MathJax.",
    authors: [EquicordDevs.BinaryQuantumSoul],
    start() {
        bridge.start();
    },
    stop() {
        bridge.stop();
    }
});
