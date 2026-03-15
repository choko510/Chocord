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

import "./styles.css";

import * as DataStore from "@api/DataStore";
import { isPluginEnabled, stopPlugin } from "@api/PluginManager";
import { useSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { Card } from "@components/Card";
import { Divider } from "@components/Divider";
import ErrorBoundary from "@components/ErrorBoundary";
import { HeadingTertiary } from "@components/Heading";
import { DownArrow, RightArrow } from "@components/Icons";
import { Paragraph } from "@components/Paragraph";
import { SettingsTab } from "@components/settings";
import { GoogleLanguages } from "@plugins/translate/languages";
import { debounce } from "@shared/debounce";
import { ChangeList } from "@utils/ChangeList";
import { classNameFactory } from "@utils/css";
import { isTruthy } from "@utils/guards";
import { Logger } from "@utils/Logger";
import { Margins } from "@utils/margins";
import { classes } from "@utils/misc";
import { useAwaiter, useIntersection } from "@utils/react";
import { useSettingsI18n } from "@utils/settingsI18n";
import { Alerts, lodash, Parser, React, Select, SelectedChannelStore, TextInput, Toasts, Tooltip, useCallback, useMemo, useState, useStateFromStores } from "@webpack/common";
import { JSX } from "react";

import Plugins, { ExcludedPlugins, PluginMeta } from "~plugins";

import { PluginCard } from "./PluginCard";
import { createPluginCategoryResolver, PLUGIN_CATEGORY_LABELS, PLUGIN_CATEGORY_ORDER, PluginCategory } from "./pluginCategories";
import { openWarningModal } from "./PluginModal";
import { StockPluginsCard, UserPluginsCard } from "./PluginStatCards";
import { UIElementsButton } from "./UIElements";

export const cl = classNameFactory("vc-plugins-");
export const logger = new Logger("PluginSettings", "#a6d189");
const DESCRIPTION_TRANSLATION_DISABLED = "off";
const DESCRIPTION_TRANSLATION_LANGUAGE_STORE_KEY = "Vencord_pluginDescriptionLanguage";

function showErrorToast(message: string) {
    Toasts.show({
        message,
        type: Toasts.Type.FAILURE,
        id: Toasts.genId(),
        options: {
            position: Toasts.Position.BOTTOM
        }
    });
}

function restartWithVoiceCallWarning(t: (text: string, vars?: Record<string, string | number>) => string) {
    if (!SelectedChannelStore.getVoiceChannelId()) {
        location.reload();
        return;
    }

    Alerts.show({
        title: t("You're in a voice call"),
        body: (
            <>
                <p style={{ textAlign: "center" }}>{t("Restarting now will disconnect your current call.")}</p>
                <p style={{ textAlign: "center" }}>{t("Would you like to restart anyway?")}</p>
            </>
        ),
        confirmText: t("Restart Anyway"),
        cancelText: t("Later"),
        onConfirm: () => location.reload()
    });
}

function ReloadRequiredCard({ required, enabledPlugins, openWarningModal, resetCheckAndDo, isInVoiceCall }) {
    const t = useSettingsI18n();

    return (
        <Card className={classes(cl("info-card"), required && "vc-warning-card")}>
            {required ? (
                <>
                    <HeadingTertiary>{t("Restart required!")}</HeadingTertiary>
                    <Paragraph className={cl("dep-text")}>
                        {t("Restart now to apply new plugins and their settings")}
                    </Paragraph>
                    {isInVoiceCall && (
                        <Paragraph className={cl("dep-text")}>
                            {t("You are in a voice call. Restarting now will disconnect it.")}
                        </Paragraph>
                    )}
                    <Button variant="primary" className={cl("restart-button")} onClick={() => restartWithVoiceCallWarning(t)}>
                        {t("Restart")}
                    </Button>
                </>
            ) : (
                <>
                    <HeadingTertiary>{t("Plugin Management")}</HeadingTertiary>
                    <Paragraph>{t("Press the cog wheel or info icon to get more info on a plugin")}</Paragraph>
                    <Paragraph>{t("Plugins with a cog wheel have settings you can modify!")}</Paragraph>
                </>
            )}
            {enabledPlugins.length > 0 && !required && (
                <Button
                    variant="secondary"
                    size="small"
                    className={"vc-plugins-disable-warning vc-modal-align-reset"}
                    onClick={() => {
                        return openWarningModal(null, undefined, false, enabledPlugins.length, resetCheckAndDo);
                    }}
                >
                    {t("Disable All Plugins")}
                </Button>
            )}
        </Card>
    );
}

const enum SearchStatus {
    ALL,
    ENABLED,
    DISABLED,
    EQUICORD,
    CHOCORD,
    VENCORD,
    NEW,
    USER_PLUGINS,
    API_PLUGINS
}

export const ExcludedReasons: Record<"web" | "discordDesktop" | "vesktop" | "equibop" | "desktop" | "dev", string> = {
    desktop: "Discord Desktop app or Vesktop/Equibop",
    discordDesktop: "Discord Desktop app",
    vesktop: "Vesktop/Equibop apps",
    equibop: "Vesktop/Equibop apps",
    web: "Vesktop/Equibop apps & Discord web",
    dev: "Developer version of Chocord"
};

function ExcludedPluginsList({ search }: { search: string; }) {
    const t = useSettingsI18n();

    const matchingExcludedPlugins = search
        ? Object.entries(ExcludedPlugins)
            .filter(([name]) => name.toLowerCase().includes(search))
        : [];

    return (
        <Paragraph className={Margins.top16}>
            {matchingExcludedPlugins.length
                ? <>
                    <Paragraph>{t("Are you looking for:")}</Paragraph>
                    <ul>
                        {matchingExcludedPlugins.map(([name, reason]) => (
                            <li key={name}>
                                <b>{name}</b>: {t("Only available on the {platform}", {
                                    platform: t(ExcludedReasons[reason])
                                })}
                            </li>
                        ))}
                    </ul>
                </>
                : t("No plugins meet the search criteria.")
            }
        </Paragraph>
    );
}

interface PluginCardEntry {
    category: PluginCategory;
    plugin: typeof Plugins[keyof typeof Plugins];
}

export default function PluginSettings() {
    const t = useSettingsI18n();
    const settings = useSettings();
    const changes = React.useMemo(() => new ChangeList<string>(), []);
    const isInVoiceCall = useStateFromStores(
        [SelectedChannelStore],
        () => Boolean(SelectedChannelStore.getVoiceChannelId())
    );

    const [collapsedCategories, setCollapsedCategories] = useState<Set<PluginCategory>>(new Set());
    const toggleCategory = useCallback((category: PluginCategory) => {
        setCollapsedCategories(prev => {
            const next = new Set(prev);
            if (next.has(category)) next.delete(category);
            else next.add(category);
            return next;
        });
    }, []);

    React.useEffect(() => {
        return () => {
            if (!changes.hasChanges) return;

            if (SelectedChannelStore.getVoiceChannelId()) {
                    Toasts.show({
                        message: t("Plugin changes still require a restart. Restart was deferred because you're in a voice call."),
                        type: Toasts.Type.MESSAGE,
                        id: Toasts.genId(),
                        options: {
                        position: Toasts.Position.BOTTOM
                    }
                });
                return;
            }

            const allChanges = [...changes.getChanges()];
            const pluginNames = [...new Set(allChanges.map(s => s.split(":")[0]))];
            const maxDisplay = 15;
            const displayed = pluginNames.slice(0, maxDisplay);
            const remainingCount = pluginNames.length - displayed.length;

            Alerts.show({
                title: t("Restart required"),
                body: (
                    <div>
                        {displayed.map((s, i) => (
                            <span key={i}>
                                {i > 0 && ", "}
                                {Parser.parse("`" + s + "`")}
                            </span>
                        ))}
                        {remainingCount > 0 && <span> {t("and {count} more", { count: remainingCount })}</span>}
                    </div>
                ),
                confirmText: t("Restart now"),
                cancelText: t("Later!"),
                onConfirm: () => restartWithVoiceCallWarning(t)
            });
        };
    }, []);

    const depMap = useMemo(() => {
        const o = {} as Record<string, string[]>;
        for (const plugin in Plugins) {
            const deps = Plugins[plugin].dependencies;
            if (deps) {
                for (const dep of deps) {
                    o[dep] ??= [];
                    o[dep].push(plugin);
                }
            }
        }
        return o;
    }, []);

    const sortedPlugins = useMemo(() => Object.values(Plugins)
        .sort((a, b) => a.name.localeCompare(b.name)), []);
    const nonApiPlugins = useMemo(
        () => sortedPlugins.filter(plugin => !plugin.name.endsWith("API") && !plugin.required),
        [sortedPlugins]
    );
    const { totalStockPlugins, totalUserPlugins } = useMemo(() => {
        let stock = 0;
        let user = 0;

        for (const plugin of nonApiPlugins) {
            if (PluginMeta[plugin.name].userPlugin) {
                user++;
                continue;
            }

            if (!plugin.hidden) {
                stock++;
            }
        }

        return { totalStockPlugins: stock, totalUserPlugins: user };
    }, [nonApiPlugins]);
    const resolvePluginCategory = useMemo(
        () => createPluginCategoryResolver(
            sortedPlugins.map(plugin => ({
                name: plugin.name,
                tags: plugin.tags,
                folderName: PluginMeta[plugin.name]?.folderName
            }))
        ),
        [sortedPlugins]
    );

    const hasUserPlugins = useMemo(() => !IS_STANDALONE && Object.values(PluginMeta).some(m => m.userPlugin), []);
    const descriptionLanguageOptions = useMemo(() => ([
        { label: t("Original descriptions"), value: DESCRIPTION_TRANSLATION_DISABLED, default: true },
        ...Object.entries(GoogleLanguages)
            .filter(([code]) => code !== "auto")
            .map(([value, label]) => ({ label, value }))
    ]), [t]);
    const descriptionLanguageOptionValues = useMemo(
        () => new Set(descriptionLanguageOptions.map(option => option.value)),
        [descriptionLanguageOptions]
    );
    const [descriptionLanguage, setDescriptionLanguage] = useState<string>(DESCRIPTION_TRANSLATION_DISABLED);

    const [searchValue, setSearchValue] = useState({ value: "", status: SearchStatus.ALL });
    const [searchInput, setSearchInput] = useState("");

    const debouncedSetSearch = useMemo(
        () => debounce((query: string) => setSearchValue(prev => ({ ...prev, value: query })), 150),
        []
    );
    React.useEffect(() => () => debouncedSetSearch.cancel(), [debouncedSetSearch]);

    const search = searchValue.value.toLowerCase();
    const onSearch = useCallback((query: string) => {
        setSearchInput(query);
        debouncedSetSearch(query);
    }, [debouncedSetSearch]);
    const onStatusChange = useCallback((status: SearchStatus) => {
        setSearchValue(prev => ({ ...prev, status }));
    }, []);
    const onDescriptionLanguageChange = useCallback((language: string) => {
        setDescriptionLanguage(language);
        void DataStore.set(DESCRIPTION_TRANSLATION_LANGUAGE_STORE_KEY, language)
            .catch(error => logger.error("Failed to store plugin description translation language", error));
    }, []);
    const selectedDescriptionLanguage = descriptionLanguage === DESCRIPTION_TRANSLATION_DISABLED
        ? void 0
        : descriptionLanguage;

    React.useEffect(() => {
        let isMounted = true;
        void DataStore.get(DESCRIPTION_TRANSLATION_LANGUAGE_STORE_KEY)
            .then(storedLanguage => {
                if (!isMounted || typeof storedLanguage !== "string" || !descriptionLanguageOptionValues.has(storedLanguage))
                    return;

                setDescriptionLanguage(storedLanguage);
            })
            .catch(error => logger.error("Failed to load plugin description translation language", error));

        return () => {
            isMounted = false;
        };
    }, [descriptionLanguageOptionValues]);

    const pluginFilter = useCallback((plugin: typeof Plugins[keyof typeof Plugins], newPluginsSet: Set<string> | null) => {
        const { status } = searchValue;
        const enabled = isPluginEnabled(plugin.name);

        switch (status) {
            case SearchStatus.DISABLED:
                if (enabled) return false;
                break;
            case SearchStatus.ENABLED:
                if (!enabled) return false;
                break;
            case SearchStatus.EQUICORD:
                if (!PluginMeta[plugin.name].folderName.startsWith("src/equicordplugins/")) return false;
                break;
            case SearchStatus.CHOCORD:
                if (!PluginMeta[plugin.name].folderName.startsWith("src/chocordplugins/")) return false;
                break;
            case SearchStatus.VENCORD:
                if (!PluginMeta[plugin.name].folderName.startsWith("src/plugins/")) return false;
                break;
            case SearchStatus.NEW:
                if (!newPluginsSet?.has(plugin.name)) return false;
                break;
            case SearchStatus.USER_PLUGINS:
                if (!PluginMeta[plugin.name]?.userPlugin) return false;
                break;
            case SearchStatus.API_PLUGINS:
                if (!plugin.name.endsWith("API")) return false;
                break;
        }

        if (!search.length) return true;

        return (
            plugin.name.toLowerCase().includes(search.replace(/\s+/g, "")) ||
            plugin.description.toLowerCase().includes(search) ||
            plugin.tags?.some(t => t.toLowerCase().includes(search))
        );
    }, [searchValue, search]);

    const [newPluginsSet] = useAwaiter(() => DataStore.get("Vencord_existingPlugins").then((cachedPlugins: Record<string, number> | undefined) => {
        const now = Date.now() / 1000;
        const existingTimestamps: Record<string, number> = {};
        const sortedPluginNames = Object.values(sortedPlugins).map(plugin => plugin.name);

        const newPlugins: string[] = [];
        for (const { name: p } of sortedPlugins) {
            const time = existingTimestamps[p] = cachedPlugins?.[p] ?? now;
            if ((time + 60 * 60 * 24 * 2) > now) {
                newPlugins.push(p);
            }
        }
        DataStore.set("Vencord_existingPlugins", existingTimestamps);

        return lodash.isEqual(newPlugins, sortedPluginNames) ? null : new Set(newPlugins);
    }));

    const handleRestartNeeded = useCallback((name: string, key: string) => changes.handleChange(`${name}:${key}`), [changes]);

    const { pluginEntries, requiredPlugins } = useMemo(() => {
        const pluginEntries = [] as PluginCardEntry[];
        const requiredPlugins = [] as JSX.Element[];

        const showApi = searchValue.status === SearchStatus.API_PLUGINS;
        for (const p of sortedPlugins) {
            if (p.hidden || (!p.settings?.def && p.name.endsWith("API") && !showApi))
                continue;

            if (!pluginFilter(p, newPluginsSet)) continue;

            const isRequired = p.required || p.isDependency || depMap[p.name]?.some(d => settings.plugins[d].enabled);

            if (isRequired) {
                const tooltipText = p.required || !depMap[p.name]
                    ? t("This plugin is required for Chocord to function.")
                    : <PluginDependencyList deps={depMap[p.name]?.filter(d => settings.plugins[d].enabled)} />;

                requiredPlugins.push(
                    <Tooltip text={tooltipText} key={p.name}>
                        {({ onMouseLeave, onMouseEnter }) => (
                            <PluginCard
                                onMouseLeave={onMouseLeave}
                                onMouseEnter={onMouseEnter}
                                onRestartNeeded={handleRestartNeeded}
                                disabled={true}
                                plugin={p}
                                descriptionLanguage={selectedDescriptionLanguage}
                            />
                        )}
                    </Tooltip>
                );
            } else {
                pluginEntries.push({
                    category: resolvePluginCategory(p.name),
                    plugin: p
                });
            }
        }
        return { pluginEntries, requiredPlugins };
    }, [sortedPlugins, searchValue, newPluginsSet, depMap, settings.plugins, pluginFilter, handleRestartNeeded, selectedDescriptionLanguage, resolvePluginCategory]);

    function resetCheckAndDo() {
        let restartNeeded = false;

        for (const plugin of enabledPlugins) {
            const pluginSettings = settings.plugins[plugin];

            if (Plugins[plugin].patches?.length) {
                pluginSettings.enabled = false;
                changes.handleChange(plugin);
                restartNeeded = true;
                continue;
            }

            const result = stopPlugin(Plugins[plugin]);

            if (!result) {
                logger.error(`Error while stopping plugin ${plugin}`);
                showErrorToast(t("Error while stopping plugin {plugin}", { plugin }));
                continue;
            }

            pluginSettings.enabled = false;
        }

        if (restartNeeded) {
            Alerts.show({
                title: t("Restart Required"),
                body: (
                    <>
                        <p style={{ textAlign: "center" }}>{t("Some plugins require a restart to fully disable.")}</p>
                        <p style={{ textAlign: "center" }}>{t("Would you like to restart now?")}</p>
                    </>
                ),
                confirmText: t("Restart Now"),
                cancelText: t("Later"),
                onConfirm: () => restartWithVoiceCallWarning(t)
            });
        }
    }

    // Code directly taken from supportHelper.tsx
    const { enabledStockPlugins, enabledUserPlugins, enabledPlugins } = useMemo(() => {
        const enabledPlugins: string[] = [];
        let enabledStockPlugins = 0;
        let enabledUserPlugins = 0;

        for (const plugin of nonApiPlugins) {
            if (!isPluginEnabled(plugin.name)) continue;

            enabledPlugins.push(plugin.name);
            if (PluginMeta[plugin.name].userPlugin) {
                enabledUserPlugins++;
            } else {
                enabledStockPlugins++;
            }
        }

        return { enabledStockPlugins, enabledUserPlugins, enabledPlugins };
    }, [nonApiPlugins, settings.plugins]);
    const pluginsToLoad = Math.min(36, pluginEntries.length);
    const [visibleCount, setVisibleCount] = React.useState(pluginsToLoad);
    const loadMore = React.useCallback(() => {
        setVisibleCount(v => Math.min(v + pluginsToLoad, pluginEntries.length));
    }, [pluginEntries.length]);

    const dLoadMore = useMemo(() => debounce(loadMore, 100), [loadMore]);
    React.useEffect(() => () => dLoadMore.cancel(), [dLoadMore]);

    const [sentinelRef, isSentinelVisible] = useIntersection();
    React.useEffect(() => {
        if (isSentinelVisible && visibleCount < pluginEntries.length) {
            dLoadMore();
        }
    }, [isSentinelVisible, visibleCount, pluginEntries.length, dLoadMore]);

    const visiblePluginEntries = pluginEntries.slice(0, visibleCount);
    const groupedVisiblePlugins = useMemo(() => {
        const groupedPlugins = new Map<PluginCategory, Array<typeof Plugins[keyof typeof Plugins]>>();
        for (const category of PLUGIN_CATEGORY_ORDER) {
            groupedPlugins.set(category, []);
        }

        for (const { category, plugin } of visiblePluginEntries) {
            groupedPlugins.get(category)?.push(plugin);
        }

        return PLUGIN_CATEGORY_ORDER
            .map(category => ({
                category,
                plugins: groupedPlugins.get(category) ?? []
            }))
            .filter(({ plugins }) => plugins.length > 0);
    }, [visiblePluginEntries]);

    return (
        <SettingsTab>
            <ReloadRequiredCard
                required={changes.hasChanges}
                enabledPlugins={enabledPlugins}
                openWarningModal={openWarningModal}
                resetCheckAndDo={resetCheckAndDo}
                isInVoiceCall={isInVoiceCall}
            />

            <div className={cl("stats-container")}>
                <StockPluginsCard
                    totalStockPlugins={totalStockPlugins}
                    enabledStockPlugins={enabledStockPlugins}
                />
                <UserPluginsCard
                    totalUserPlugins={totalUserPlugins}
                    enabledUserPlugins={enabledUserPlugins}
                />
            </div>

            <div className={cl("ui-elements")}>
                <UIElementsButton />
            </div>

            <HeadingTertiary className={classes(Margins.top20, Margins.bottom8)}>
                {t("Filters")}
            </HeadingTertiary>

            <div className={classes(Margins.bottom20, cl("filter-controls"))}>
                <ErrorBoundary noop>
                    <TextInput autoFocus value={searchInput} placeholder={t("Search for a plugin...")} onChange={onSearch} />
                </ErrorBoundary>
                <div>
                    <ErrorBoundary noop>
                        <Select
                            options={[
                                { label: t("Show All"), value: SearchStatus.ALL, default: true },
                                { label: t("Show Enabled"), value: SearchStatus.ENABLED },
                                { label: t("Show Disabled"), value: SearchStatus.DISABLED },
                                { label: t("Show EquicordPlugins"), value: SearchStatus.EQUICORD },
                                { label: t("Show ChocordPlugins"), value: SearchStatus.CHOCORD },
                                { label: t("Show Vencord"), value: SearchStatus.VENCORD },
                                { label: t("Show New"), value: SearchStatus.NEW },
                                hasUserPlugins && { label: t("Show UserPlugins"), value: SearchStatus.USER_PLUGINS },
                                { label: t("Show API Plugins"), value: SearchStatus.API_PLUGINS },
                            ].filter(isTruthy)}
                            serialize={String}
                            select={onStatusChange}
                            isSelected={v => v === searchValue.status}
                            closeOnSelect={true}
                        />
                    </ErrorBoundary>
                </div>
                <div>
                    <ErrorBoundary noop>
                        <Select
                            options={descriptionLanguageOptions}
                            serialize={String}
                            select={onDescriptionLanguageChange}
                            isSelected={v => v === descriptionLanguage}
                            closeOnSelect={true}
                        />
                    </ErrorBoundary>
                </div>
            </div>

            <HeadingTertiary className={Margins.top20}>{t("Plugins")}</HeadingTertiary>

            {pluginEntries.length || requiredPlugins.length
                ? (
                    <>
                        {groupedVisiblePlugins.length
                            ? groupedVisiblePlugins.map(({ category, plugins }) => {
                                const isCollapsed = collapsedCategories.has(category);
                                return (
                                    <section key={category} className={cl("category-section")}>
                                        <HeadingTertiary
                                            className={classes(cl("category-heading"), isCollapsed && cl("category-collapsed"))}
                                            onClick={() => toggleCategory(category)}
                                        >
                                            {isCollapsed ? <RightArrow className={cl("category-icon")} /> : <DownArrow className={cl("category-icon")} />}
                                            {PLUGIN_CATEGORY_LABELS[category]} ({plugins.length})
                                        </HeadingTertiary>
                                        {!isCollapsed && (
                                            <div className={cl("grid")}>
                                                {plugins.map(plugin => (
                                                    <PluginCard
                                                        key={plugin.name}
                                                        onRestartNeeded={handleRestartNeeded}
                                                        disabled={false}
                                                        plugin={plugin}
                                                        descriptionLanguage={selectedDescriptionLanguage}
                                                    />
                                                ))}
                                            </div>
                                        )}
                                    </section>
                                );
                            })
                            : <Paragraph>{t("No plugins meet the search criteria.")}</Paragraph>
                        }
                        {visibleCount < pluginEntries.length && (
                            <div ref={sentinelRef} style={{ height: 32 }} />
                        )}
                    </>
                )
                : <ExcludedPluginsList search={search} />
            }

            <Divider className={Margins.top20} />

            <HeadingTertiary className={classes(Margins.top20, Margins.bottom8)}>
                Required Plugins
            </HeadingTertiary>
            <div className={cl("grid")}>
                {requiredPlugins.length
                    ? requiredPlugins
                    : <Paragraph>{t("No plugins meet the search criteria.")}</Paragraph>
                }
            </div>
        </SettingsTab >
    );
}

export function PluginDependencyList({ deps }: { deps: string[]; }) {
    const t = useSettingsI18n();

    return (
        <>
            <Paragraph>{t("This plugin is required by:")}</Paragraph>
            {deps.map((dep: string) => <Paragraph key={dep} className={cl("dep-text")}>{dep}</Paragraph>)}
        </>
    );
}
