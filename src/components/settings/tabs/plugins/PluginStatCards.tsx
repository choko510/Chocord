/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { BaseText } from "@components/BaseText";
import { useSettingsI18n } from "@utils/settingsI18n";
import { Tooltip } from "@webpack/common";

export function StockPluginsCard({ totalStockPlugins, enabledStockPlugins }) {
    const t = useSettingsI18n();

    return (
        <div className="vc-plugin-stats vc-stockplugins-stats-card">
            <div className="vc-plugin-stats-card-container">
                <div className="vc-plugin-stats-card-section">
                    <BaseText size="md" weight="semibold">{t("Enabled Plugins")}</BaseText>
                    <BaseText size="xl" weight="bold">{enabledStockPlugins}</BaseText>
                </div>
                <div className="vc-plugin-stats-card-divider"></div>
                <div className="vc-plugin-stats-card-section">
                    <BaseText size="md" weight="semibold">{t("Total Plugins")}</BaseText>
                    <BaseText size="xl" weight="bold">{totalStockPlugins}</BaseText>
                </div>
            </div>
        </div>
    );
}

export function UserPluginsCard({ totalUserPlugins, enabledUserPlugins }) {
    const t = useSettingsI18n();

    if (totalUserPlugins === 0)
        return (
            <div className="vc-plugin-stats vc-stockplugins-stats-card">
                <div className="vc-plugin-stats-card-container ">
                    <div className="vc-plugin-stats-card-section">
                        <BaseText size="md" weight="semibold">{t("Total Userplugins")}</BaseText>
                        <Tooltip
                            text={
                                <img
                                    src="https://discord.com/assets/ab6835d2922224154ddf.svg"
                                    style={{ width: "40px", height: "40px" }}
                                />
                            }
                        >
                            {tooltipProps => (
                                <span style={{ display: "inline", position: "relative" }}>
                                    <BaseText size="xl" weight="bold" {...tooltipProps}>
                                        {totalUserPlugins}
                                    </BaseText>
                                </span>
                            )}
                        </Tooltip>
                    </div>
                </div>
            </div>
        );
    else
        return (
            <div className="vc-plugin-stats vc-stockplugins-stats-card">
                    <div className="vc-plugin-stats-card-container">
                        <div className="vc-plugin-stats-card-section">
                            <BaseText size="md" weight="semibold">{t("Enabled Userplugins")}</BaseText>
                            <BaseText size="xl" weight="bold">{enabledUserPlugins}</BaseText>
                        </div>
                        <div className="vc-plugin-stats-card-divider"></div>
                        <div className="vc-plugin-stats-card-section">
                            <BaseText size="md" weight="semibold">{t("Total Userplugins")}</BaseText>
                            <BaseText size="xl" weight="bold">{totalUserPlugins}</BaseText>
                        </div>
                    </div>
            </div>
        );
}
