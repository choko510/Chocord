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
import { OptionType, Plugin } from "@utils/types";
import { React, showToast, Toasts } from "@webpack/common";

import { PluginMeta } from "~plugins";

import { openPluginModal } from "./PluginModal";

const logger = new Logger("PluginCard");
const cl = classNameFactory("vc-plugins-");
const DESCRIPTION_TRANSLATE_API_KEY = "AIzaSyDLEeFI5OtFBwYBIoK_jj5m32rZK5CkCXA";
const translatedDescriptionCache = new Map<string, string>();
const inflightDescriptionTranslations = new Map<string, Promise<string>>();
const showTranslateErrorToast = onlyOnce(
    () => showToast("Failed to translate some plugin descriptions.", Toasts.Type.FAILURE)
);

interface GoogleTranslationData {
    translation: string;
}

function getDescriptionTranslationCacheKey(description: string, targetLanguage: string) {
    return `${targetLanguage}:${description}`;
}

async function translateDescription(description: string, targetLanguage: string) {
    const cacheKey = getDescriptionTranslationCacheKey(description, targetLanguage);
    const cachedValue = translatedDescriptionCache.get(cacheKey);
    if (cachedValue) return cachedValue;

    const inflightTranslation = inflightDescriptionTranslations.get(cacheKey);
    if (inflightTranslation) return inflightTranslation;

    const translationPromise = (async () => {
        const url = "https://translate-pa.googleapis.com/v1/translate?" + new URLSearchParams({
            "params.client": "gtx",
            "dataTypes": "TRANSLATION",
            "key": DESCRIPTION_TRANSLATE_API_KEY,
            "query.sourceLanguage": "auto",
            "query.targetLanguage": targetLanguage,
            "query.text": description,
        });

        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(
                `Failed to translate plugin description (${targetLanguage})`
                + `\n${response.status} ${response.statusText}`
            );
        }

        const { translation }: GoogleTranslationData = await response.json();
        translatedDescriptionCache.set(cacheKey, translation);
        return translation;
    })();

    inflightDescriptionTranslations.set(cacheKey, translationPromise);
    try {
        return await translationPromise;
    } finally {
        inflightDescriptionTranslations.delete(cacheKey);
    }
}

interface PluginCardProps extends React.HTMLProps<HTMLDivElement> {
    plugin: Plugin;
    disabled?: boolean;
    onRestartNeeded(name: string, key: string): void;
    descriptionLanguage?: string;
    onMouseEnter?: React.MouseEventHandler<HTMLDivElement>;
    onMouseLeave?: React.MouseEventHandler<HTMLDivElement>;
}

export function PluginCard({ plugin, disabled, onRestartNeeded, onMouseEnter, onMouseLeave, descriptionLanguage }: PluginCardProps) {
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

        const cachedTranslation = translatedDescriptionCache.get(
            getDescriptionTranslationCacheKey(plugin.description, descriptionLanguage)
        );

        if (cachedTranslation) {
            setTranslatedDescription(cachedTranslation);
            return;
        }

        let isMounted = true;
        setTranslatedDescription(plugin.description);
        void translateDescription(plugin.description, descriptionLanguage)
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
                showNotice("Failed to start dependencies: " + failures.join(", "), "Close", () => null);
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

            const msg = `Error while ${wasEnabled ? "stopping" : "starting"} plugin ${plugin.name}`;
            showToast(msg, Toasts.Type.FAILURE, {
                position: Toasts.Position.BOTTOM,
            });

            return;
        }

        settings.enabled = !wasEnabled;
    }

    const pluginInfo = [
        {
            condition: isModifiedPlugin,
            src: "https://equicord.org/assets/icons/equicord/modified.png",
            alt: "Modified",
            title: "Modified Vencord Plugin"
        },
        {
            condition: isEquicordPlugin,
            src: "https://equicord.org/assets/favicon.png",
            alt: "EquicordPlugins",
            title: "EquicordPlugins Plugin"
        },
        {
            condition: isChocordPlugin,
            src: "https://equicord.org/assets/favicon.png",
            alt: "ChocordPlugins",
            title: "Chocord Plugin"
        },
        {
            condition: isVencordPlugin,
            src: "https://equicord.org/assets/icons/vencord/icon-light.png",
            alt: "Vencord",
            title: "Vencord Plugin"
        },
        {
            condition: isUserPlugin,
            src: "https://equicord.org/assets/icons/misc/userplugin.png",
            alt: "User",
            title: "User Plugin"
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

    const tooltip = pluginDetails?.title || "Unknown Plugin";

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
                    onClick={() => openPluginModal(plugin, onRestartNeeded, translatedDescription)}
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
