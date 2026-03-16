/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { showNotice } from "@api/Notices";
import { isPluginEnabled, pluginRequiresRestart, startDependenciesRecursive, startPlugin, stopPlugin } from "@api/PluginManager";
import { useSettings } from "@api/Settings";
import { CogWheel, InfoIcon } from "@components/Icons";
import { AddonCard } from "@components/settings/AddonCard";
import { classNameFactory } from "@utils/css";
import { Logger } from "@utils/Logger";
import { onlyOnce } from "@utils/onlyOnce";
import { translateSettingsText, useSettingsI18n } from "@utils/settingsI18n";
import { OptionType, Plugin } from "@utils/types";
import { React, showToast, Toasts } from "@webpack/common";

import { PluginMeta } from "~plugins";

import { openPluginModal } from "./PluginModal";
import { getCachedPluginTranslation, translatePluginText } from "./pluginTranslation";

const logger = new Logger("PluginCard");
const cl = classNameFactory("vc-plugins-");
const showTranslateErrorToast = onlyOnce(
    () => showToast(translateSettingsText("Failed to translate some plugin descriptions."), Toasts.Type.FAILURE)
);

interface PluginCardProps extends React.HTMLProps<HTMLDivElement> {
    plugin: Plugin;
    disabled?: boolean;
    onRestartNeeded(name: string, key: string): void;
    descriptionLanguage?: string;
    onMouseEnter?: React.MouseEventHandler<HTMLDivElement>;
    onMouseLeave?: React.MouseEventHandler<HTMLDivElement>;
}

export function PluginCard({ plugin, disabled, onRestartNeeded, onMouseEnter, onMouseLeave, descriptionLanguage }: PluginCardProps) {
    const t = useSettingsI18n();
    const settingsStore = useSettings([`plugins.${plugin.name}.enabled` as any]);
    const settings = settingsStore.plugins[plugin.name];
    const pluginMeta = PluginMeta[plugin.name];
    const isEquicordPlugin = pluginMeta.folderName.startsWith("src/equicordplugins/") ?? false;
    const isChocordPlugin = pluginMeta.folderName.startsWith("src/chocordplugins/") ?? false;
    const isVencordPlugin = pluginMeta.folderName.startsWith("src/plugins/") ?? false;
    const isUserPlugin = pluginMeta?.userPlugin ?? false;
    const isModifiedPlugin = plugin.isModified ?? false;
    const [translatedDescription, setTranslatedDescription] = React.useState(plugin.description);

    const isEnabled = () => isPluginEnabled(plugin.name);

    React.useEffect(() => {
        if (!descriptionLanguage) {
            setTranslatedDescription(plugin.description);
            return;
        }

        const cachedTranslation = getCachedPluginTranslation(plugin.description, descriptionLanguage);

        if (cachedTranslation) {
            setTranslatedDescription(cachedTranslation);
            return;
        }

        let isMounted = true;
        setTranslatedDescription(plugin.description);
        void translatePluginText(plugin.description, descriptionLanguage)
            .then(translated => {
                if (!isMounted) return;
                setTranslatedDescription(translated);
            })
            .catch(error => {
                logger.error(`Error while translating plugin description for ${plugin.name}:`, error);
                showTranslateErrorToast();
                if (isMounted) setTranslatedDescription(plugin.description);
            });

        return () => {
            isMounted = false;
        };
    }, [descriptionLanguage, plugin.description, plugin.name]);

    function toggleEnabled() {
        const wasEnabled = isEnabled();

        // If we're enabling a plugin, make sure all deps are enabled recursively.
        if (!wasEnabled) {
            const { restartNeeded, failures } = startDependenciesRecursive(plugin);

            if (failures.length) {
                logger.error(`Failed to start dependencies for ${plugin.name}: ${failures.join(", ")}`);
                showNotice(t("Failed to start dependencies: {deps}", { deps: failures.join(", ") }), t("Close"), () => null);
                return;
            }

            if (restartNeeded) {
                // If any dependencies have patches, don't start the plugin yet.
                settings.enabled = true;
                onRestartNeeded(plugin.name, "enabled");
                return;
            }
        }

        // if the plugin requires a restart, don't use stopPlugin/startPlugin. Wait for restart to apply changes.
        if (pluginRequiresRestart(plugin)) {
            settings.enabled = !wasEnabled;
            onRestartNeeded(plugin.name, "enabled");
            return;
        }

        // If the plugin is enabled, but hasn't been started, then we can just toggle it off.
        if (wasEnabled && !plugin.started) {
            settings.enabled = !wasEnabled;
            return;
        }

        const result = wasEnabled ? stopPlugin(plugin) : startPlugin(plugin);

        if (!result) {
            settings.enabled = false;

            const action = wasEnabled ? t("stopping") : t("starting");
            const localizedMsg = t("Error while {action} plugin {plugin}", { action, plugin: plugin.name });
            showToast(localizedMsg, Toasts.Type.FAILURE, {
                position: Toasts.Position.BOTTOM,
            });
            logger.error(localizedMsg);

            return;
        }

        settings.enabled = !wasEnabled;
    }

    const pluginInfo = [
        {
            condition: isModifiedPlugin,
            src: "https://equicord.org/assets/icons/equicord/modified.png",
            alt: t("Modified"),
            title: t("Modified Vencord Plugin")
        },
        {
            condition: isEquicordPlugin,
            src: "https://equicord.org/assets/favicon.png",
            alt: "EquicordPlugins",
            title: t("EquicordPlugins Plugin")
        },
        {
            condition: isChocordPlugin,
            src: "https://equicord.org/assets/favicon.png",
            alt: "ChocordPlugins",
            title: t("Chocord Plugin")
        },
        {
            condition: isVencordPlugin,
            src: "https://equicord.org/assets/icons/vencord/icon-light.png",
            alt: "Vencord",
            title: t("Vencord Plugin")
        },
        {
            condition: isUserPlugin,
            src: "https://equicord.org/assets/icons/misc/userplugin.png",
            alt: "User",
            title: t("User Plugin")
        }
    ];

    const pluginDetails = pluginInfo.find(p => p.condition);

    const sourceBadge = pluginDetails ? (
        <img
            src={pluginDetails.src}
            alt={pluginDetails.alt}
            className={cl("source")}
        />
    ) : null;

    const tooltip = pluginDetails?.title || t("Unknown Plugin");

    return (
        <AddonCard
            name={plugin.name}
            sourceBadge={sourceBadge}
            tooltip={tooltip}
            description={translatedDescription}
            enabled={isEnabled()}
            setEnabled={toggleEnabled}
            disabled={disabled}
            onMouseEnter={onMouseEnter}
            onMouseLeave={onMouseLeave}
            infoButton={
                <button
                    role="switch"
                    onClick={() => openPluginModal(plugin, onRestartNeeded, translatedDescription, descriptionLanguage)}
                    className={cl("info-button")}
                >
                    {plugin.settings?.def && Object.values(plugin.settings.def).some(s => s.type !== OptionType.CUSTOM && !s.hidden)
                        ? <CogWheel className={cl("info-icon")} />
                        : <InfoIcon className={cl("info-icon")} />
                    }
                </button>
            } />
    );
}
