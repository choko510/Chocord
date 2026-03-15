/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2022 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { addProfileBadge, removeProfileBadge } from "@api/Badges";
import { addChatBarButton, removeChatBarButton } from "@api/ChatButtons";
import { registerCommand, unregisterCommand } from "@api/Commands";
import { addContextMenuPatch, removeContextMenuPatch } from "@api/ContextMenu";
import { addMemberListDecorator, removeMemberListDecorator } from "@api/MemberListDecorators";
import { addMessageAccessory, removeMessageAccessory } from "@api/MessageAccessories";
import { addMessageDecoration, removeMessageDecoration } from "@api/MessageDecorations";
import { addMessageClickListener, addMessagePreEditListener, addMessagePreSendListener, removeMessageClickListener, removeMessagePreEditListener, removeMessagePreSendListener } from "@api/MessageEvents";
import { addMessagePopoverButton, removeMessagePopoverButton } from "@api/MessagePopover";
import { addNicknameIcon, removeNicknameIcon } from "@api/NicknameIcons";
import { Settings, SettingsStore } from "@api/Settings";
import { disableStyle, enableStyle } from "@api/Styles";
import { Logger } from "@utils/Logger";
import { onlyOnce } from "@utils/onlyOnce";
import { canonicalizeFind, canonicalizeReplacement } from "@utils/patches";
import { Patch, Plugin, PluginDef, ReporterTestable, StartAt } from "@utils/types";
import { FluxEvents } from "@vencord/discord-types";
import { FluxDispatcher } from "@webpack/common";
import { markPatchIndexDirty, patches } from "@webpack/patcher";

import Plugins from "~plugins";
export { Plugins as plugins };

import { traceFunction } from "../debug/Tracer";
import { addAudioProcessor, removeAudioProcessor } from "./AudioPlayer";
import { addChannelToolbarButton, addHeaderBarButton, removeChannelToolbarButton, removeHeaderBarButton } from "./HeaderBar";
import { addUserAreaButton, removeUserAreaButton } from "./UserArea";

const logger = new Logger("PluginManager", "#a6d189");

export const PMLogger = logger;

/** Whether we have subscribed to flux events of all the enabled plugins when FluxDispatcher was ready */
let enabledPluginsSubscribedFlux = false;
const subscribedFluxEventsPlugins = new Set<string>();
let pluginValuesCache: Plugin[] | null = null;

function getPluginValues(): Plugin[] {
    if (!pluginValuesCache) {
        pluginValuesCache = Object.values(Plugins);
    }
    return pluginValuesCache;
}

let enabledPluginsCache: Set<string> | null = null;

function invalidateEnabledPluginsCache() {
    enabledPluginsCache = null;
}

function isPluginMarkedEnabled(name: string) {
    return (
        Plugins[name]?.required ||
        Plugins[name]?.isDependency ||
        Settings.plugins[name]?.enabled
    ) ?? false;
}

function getEnabledPlugins() {
    if (enabledPluginsCache) {
        return enabledPluginsCache;
    }

    const enabled = new Set<string>();
    for (const plugin of getPluginValues()) {
        if (isPluginMarkedEnabled(plugin.name)) {
            enabled.add(plugin.name);
        }
    }

    enabledPluginsCache = enabled;
    return enabled;
}

SettingsStore.addGlobalChangeListener((_, path) => {
    if (!enabledPluginsCache) return;
    if (!path || path === "plugins") {
        invalidateEnabledPluginsCache();
        return;
    }

    if (!path.startsWith("plugins.")) {
        return;
    }

    const pluginPath = path.slice("plugins.".length);
    const settingSeparatorIndex = pluginPath.indexOf(".");
    if (settingSeparatorIndex === -1) {
        invalidateEnabledPluginsCache();
        return;
    }

    if (pluginPath.slice(settingSeparatorIndex + 1) === "enabled") {
        invalidateEnabledPluginsCache();
    }
});

export function isPluginEnabled(p: string) {
    return enabledPluginsCache?.has(p) ?? isPluginMarkedEnabled(p);
}

export function isPluginRequired(p: string) {
    return (
        Plugins[p]?.required
    ) ?? false;
}

export function addPatch(newPatch: Omit<Patch, "plugin">, pluginName: string, pluginPath = `Vencord.Plugins.plugins[${JSON.stringify(pluginName)}]`) {
    const patch = newPatch as Patch;
    patch.plugin = pluginName;

    if (IS_REPORTER) {
        delete patch.predicate;
        delete patch.group;
    }

    if (patch.predicate && !patch.predicate()) return;

    canonicalizeFind(patch);
    if (!Array.isArray(patch.replacement)) {
        patch.replacement = [patch.replacement];
    }

    for (const replacement of patch.replacement) {
        canonicalizeReplacement(replacement, pluginPath);

        if (IS_REPORTER) {
            delete replacement.predicate;
        }
    }

    patch.replacement = patch.replacement.filter(({ predicate }) => !predicate || predicate());

    patches.push(patch);
    markPatchIndexDirty();
}

function isReporterTestable(p: Plugin, part: ReporterTestable) {
    return p.reporterTestable == null
        ? true
        : (p.reporterTestable & part) === part;
}

export function pluginRequiresRestart(p: Plugin) {
    return p.requiresRestart !== false && (p.requiresRestart || !!p.patches?.length);
}

export const startAllPlugins = traceFunction("startAllPlugins", function startAllPlugins(target: StartAt) {
    logger.info(`Starting plugins (stage ${target})`);
    for (const name of getEnabledPlugins()) {
        const p = Plugins[name];
        if (!p || (IS_REPORTER && !isReporterTestable(p, ReporterTestable.Start))) continue;

        const startAt = p.startAt ?? StartAt.WebpackReady;
        if (startAt !== target) continue;

        startPlugin(p);
    }
});

export function startDependenciesRecursive(p: Plugin) {
    const settings = Settings.plugins;
    let restartNeeded = false;
    const failures: string[] = [];

    p.dependencies?.forEach(d => {
        if (!settings[d].enabled) {
            const dep = Plugins[d];
            startDependenciesRecursive(dep);

            // If the plugin has patches, don't start the plugin, just enable it.
            settings[d].enabled = true;
            dep.isDependency = true;
            invalidateEnabledPluginsCache();

            if (pluginRequiresRestart(dep)) {
                logger.warn(`Enabling dependency ${d} requires restart.`);
                restartNeeded = true;
                return;
            }

            const result = startPlugin(dep);
            if (!result) failures.push(d);
        }
    });

    return { restartNeeded, failures };
}

export function subscribePluginFluxEvents(p: Plugin, fluxDispatcher: typeof FluxDispatcher) {
    if (p.flux && !subscribedFluxEventsPlugins.has(p.name) && (!IS_REPORTER || isReporterTestable(p, ReporterTestable.FluxEvents))) {
        subscribedFluxEventsPlugins.add(p.name);

        logger.debug("Subscribing to flux events of plugin", p.name);
        for (const [event, handler] of Object.entries(p.flux)) {
            const wrappedHandler = p.flux[event] = function () {
                if (p.name === "Encryptcord" && event === "MESSAGE_CREATE") return;
                try {
                    const res = handler!.apply(p, arguments as any);
                    return res instanceof Promise
                        ? res.catch(e => logger.error(`${p.name}: Error while handling ${event}\n`, e))
                        : res;
                } catch (e) {
                    logger.error(`${p.name}: Error while handling ${event}\n`, e);
                }
            };

            fluxDispatcher.subscribe(event as FluxEvents, wrappedHandler);
        }
    }
}

export function unsubscribePluginFluxEvents(p: Plugin, fluxDispatcher: typeof FluxDispatcher) {
    if (p.flux) {
        subscribedFluxEventsPlugins.delete(p.name);

        logger.debug("Unsubscribing from flux events of plugin", p.name);
        for (const [event, handler] of Object.entries(p.flux)) {
            fluxDispatcher.unsubscribe(event as FluxEvents, handler!);
        }
    }
}

export function subscribeAllPluginsFluxEvents(fluxDispatcher: typeof FluxDispatcher) {
    enabledPluginsSubscribedFlux = true;

    for (const name of getEnabledPlugins()) {
        const plugin = Plugins[name];
        if (!plugin) continue;
        subscribePluginFluxEvents(plugin, fluxDispatcher);
    }
}

export const startPlugin = traceFunction("startPlugin", function startPlugin(p: Plugin) {
    const {
        name, commands, contextMenus, managedStyle, userProfileBadges,
        onBeforeMessageEdit, onBeforeMessageSend, onMessageClick,
        renderChatBarButton, chatBarButton, renderMemberListDecorator, renderMessageAccessory, renderMessageDecoration, renderMessagePopoverButton, messagePopoverButton,
        // Custom
        renderNicknameIcon, headerBarButton, audioProcessor, userAreaButton
    } = p;

    if (p.start) {
        logger.info("Starting plugin", name);
        if (p.started) {
            logger.warn(`${name} already started`);
            return false;
        }
        try {
            p.start();
        } catch (e) {
            logger.error(`Failed to start ${name}\n`, e);
            return false;
        }
    }

    p.started = true;

    if (commands?.length) {
        logger.debug("Registering commands of plugin", name);
        for (const cmd of commands) {
            try {
                registerCommand(cmd, name);
            } catch (e) {
                logger.error(`Failed to register command ${cmd.name}\n`, e);
                return false;
            }
        }
    }

    if (enabledPluginsSubscribedFlux) {
        subscribePluginFluxEvents(p, FluxDispatcher);
    }

    if (contextMenus) {
        logger.debug("Adding context menus patches of plugin", name);
        for (const navId in contextMenus) {
            addContextMenuPatch(navId, contextMenus[navId]);
        }
    }

    if (managedStyle) enableStyle(managedStyle);

    if (userProfileBadges) userProfileBadges.forEach(e => addProfileBadge(e));

    if (onBeforeMessageEdit) addMessagePreEditListener(onBeforeMessageEdit);
    if (onBeforeMessageSend) addMessagePreSendListener(onBeforeMessageSend);
    if (onMessageClick) addMessageClickListener(onMessageClick);

    if (chatBarButton) addChatBarButton(name, chatBarButton.render, chatBarButton.icon);
    // @ts-expect-error: legacy code doesn't have icon
    else if (renderChatBarButton) addChatBarButton(name, renderChatBarButton);
    if (renderMemberListDecorator) addMemberListDecorator(name, renderMemberListDecorator);
    if (renderMessageDecoration) addMessageDecoration(name, renderMessageDecoration);
    if (renderMessageAccessory) addMessageAccessory(name, renderMessageAccessory);
    if (messagePopoverButton) addMessagePopoverButton(name, messagePopoverButton.render, messagePopoverButton.icon);
    // @ts-expect-error: legacy code doesn't have icon
    else if (renderMessagePopoverButton) addMessagePopoverButton(name, renderMessagePopoverButton);

    // Custom
    if (renderNicknameIcon) addNicknameIcon(name, renderNicknameIcon);
    if (headerBarButton) {
        if (headerBarButton.location === "channeltoolbar") {
            addChannelToolbarButton(name, headerBarButton.render, headerBarButton.priority);
        } else {
            addHeaderBarButton(name, headerBarButton.render, headerBarButton.priority);
        }
    }
    if (audioProcessor) addAudioProcessor(name, audioProcessor);
    if (userAreaButton) addUserAreaButton(name, userAreaButton.render, userAreaButton.priority);

    return true;
}, p => `startPlugin ${p.name}`);

export const stopPlugin = traceFunction("stopPlugin", function stopPlugin(p: Plugin) {
    const {
        name, commands, contextMenus, managedStyle, userProfileBadges,
        onBeforeMessageEdit, onBeforeMessageSend, onMessageClick,
        renderChatBarButton, chatBarButton, renderMemberListDecorator, renderMessageAccessory, renderMessageDecoration, renderMessagePopoverButton, messagePopoverButton,
        // Custom
        renderNicknameIcon, headerBarButton, audioProcessor, userAreaButton
    } = p;

    if (p.stop) {
        logger.info("Stopping plugin", name);
        if (!p.started) {
            logger.warn(`${name} already stopped`);
            return false;
        }
        try {
            p.stop();
        } catch (e) {
            logger.error(`Failed to stop ${name}\n`, e);
            return false;
        }
    }

    p.started = false;

    if (commands?.length) {
        logger.debug("Unregistering commands of plugin", name);
        for (const cmd of commands) {
            try {
                unregisterCommand(cmd.name);
            } catch (e) {
                logger.error(`Failed to unregister command ${cmd.name}\n`, e);
                return false;
            }
        }
    }

    unsubscribePluginFluxEvents(p, FluxDispatcher);

    if (contextMenus) {
        logger.debug("Removing context menus patches of plugin", name);
        for (const navId in contextMenus) {
            removeContextMenuPatch(navId, contextMenus[navId]);
        }
    }

    if (managedStyle) disableStyle(managedStyle);

    if (userProfileBadges) userProfileBadges.forEach(e => removeProfileBadge(e));

    if (onBeforeMessageEdit) removeMessagePreEditListener(onBeforeMessageEdit);
    if (onBeforeMessageSend) removeMessagePreSendListener(onBeforeMessageSend);
    if (onMessageClick) removeMessageClickListener(onMessageClick);

    if (chatBarButton || renderChatBarButton) removeChatBarButton(name);
    if (renderMemberListDecorator) removeMemberListDecorator(name);
    if (renderMessageDecoration) removeMessageDecoration(name);
    if (renderMessageAccessory) removeMessageAccessory(name);
    if (messagePopoverButton || renderMessagePopoverButton) removeMessagePopoverButton(name);

    // Custom
    if (renderNicknameIcon) removeNicknameIcon(name);
    if (headerBarButton) {
        if (headerBarButton.location === "channeltoolbar") {
            removeChannelToolbarButton(name);
        } else {
            removeHeaderBarButton(name);
        }
    }
    if (audioProcessor) removeAudioProcessor(name);
    if (userAreaButton) removeUserAreaButton(name);

    return true;
}, p => `stopPlugin ${p.name}`);

export const initPluginManager = onlyOnce(function init() {
    const settings = Settings.plugins;
    const enabledPlugins = new Set(getEnabledPlugins());
    const enabledPluginsQueue = [...enabledPlugins];

    const pluginKeysToBind: Array<keyof PluginDef & `${"on" | "render"}${string}`> = [
        "onBeforeMessageEdit", "onBeforeMessageSend", "onMessageClick",
        "renderChatBarButton", "renderMemberListDecorator", "renderMessageAccessory", "renderMessageDecoration", "renderMessagePopoverButton",
        // Custom
        "renderNicknameIcon"
    ];

    const neededApiPlugins = new Set<string>();

    // First round-trip to mark and force enable dependencies
    //
    // FIXME: might need to revisit this if there's ever nested (dependencies of dependencies) dependencies since this only
    // goes for the top level and their children, but for now this works okay with the current API plugins
    for (let i = 0; i < enabledPluginsQueue.length; i++) {
        const pluginName = enabledPluginsQueue[i];
        const p = Plugins[pluginName];
        if (!p) continue;

        p.dependencies?.forEach(d => {
            const dep = Plugins[d];

            if (!dep) {
                const error = new Error(`Plugin ${p.name} has unresolved dependency ${d}`);

                if (IS_DEV) {
                    throw error;
                }

                logger.warn(error);
                return;
            }

            settings[d].enabled = true;
            dep.isDependency = true;

            if (!enabledPlugins.has(d)) {
                enabledPlugins.add(d);
                enabledPluginsQueue.push(d);
            }
        });

        if (p.commands?.length) neededApiPlugins.add("CommandsAPI");
        if (p.onBeforeMessageEdit || p.onBeforeMessageSend || p.onMessageClick) neededApiPlugins.add("MessageEventsAPI");
        if (p.chatBarButton || p.renderChatBarButton) neededApiPlugins.add("ChatInputButtonAPI");
        if (p.renderMemberListDecorator) neededApiPlugins.add("MemberListDecoratorsAPI");
        if (p.renderMessageAccessory) neededApiPlugins.add("MessageAccessoriesAPI");
        if (p.renderMessageDecoration) neededApiPlugins.add("MessageDecorationsAPI");
        if (p.messagePopoverButton || p.renderMessagePopoverButton) neededApiPlugins.add("MessagePopoverAPI");
        if (p.userProfileBadge) neededApiPlugins.add("BadgeAPI");

        // Custom
        if (p.renderNicknameIcon) neededApiPlugins.add("NicknameIconsAPI");
        if (p.headerBarButton) neededApiPlugins.add("HeaderBarAPI");
        if (p.audioProcessor) neededApiPlugins.add("AudioPlayerAPI");
        if (p.userAreaButton) neededApiPlugins.add("UserAreaAPI");

        for (const key of pluginKeysToBind) {
            p[key] &&= p[key].bind(p) as any;
        }
    }

    for (const p of neededApiPlugins) {
        Plugins[p].isDependency = true;
        settings[p].enabled = true;
        enabledPlugins.add(p);
    }

    enabledPluginsCache = enabledPlugins;

    for (const p of getPluginValues()) {
        if (p.settings) {
            p.options ??= {};

            p.settings.pluginName = p.name;
            for (const name in p.settings.def) {
                const def = p.settings.def[name];
                const checks = p.settings.checks?.[name];
                p.options[name] = { ...def, ...checks };
            }
        }

        if (p.options) {
            for (const name in p.options) {
                const opt = p.options[name];
                if (opt.onChange != null) {
                    SettingsStore.addChangeListener(`plugins.${p.name}.${name}`, opt.onChange);
                }
            }
        }

        if (p.patches && enabledPlugins.has(p.name)) {
            if (!IS_REPORTER || isReporterTestable(p, ReporterTestable.Patches)) {
                for (const patch of p.patches) {
                    addPatch(patch, p.name);
                }
            }
        }
    }
});
