/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./VencordTab.css";

import { openNotificationLogModal } from "@api/Notifications/notificationLog";
import { plugins } from "@api/PluginManager";
import { useSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { Divider } from "@components/Divider";
import { Flex } from "@components/Flex";
import { FormSwitch } from "@components/FormSwitch";
import { Heading } from "@components/Heading";
import { FolderIcon, GithubIcon, LogIcon, PaintbrushIcon, RestartIcon } from "@components/Icons";
import { Notice } from "@components/Notice";
import { Paragraph } from "@components/Paragraph";
import { openContributorModal, openPluginModal, SettingsTab, wrapTab } from "@components/settings";
import { QuickAction, QuickActionCard } from "@components/settings/QuickAction";
import { SpecialCard } from "@components/settings/SpecialCard";
import { gitRemote } from "@shared/vencordUserAgent";
import { DONOR_ROLE_ID, GUILD_ID, IS_MAC, IS_WINDOWS, VC_DONOR_ROLE_ID, VC_GUILD_ID } from "@utils/constants";
import { classNameFactory } from "@utils/css";
import { Margins } from "@utils/margins";
import { identity, isAnyPluginDev } from "@utils/misc";
import { relaunch } from "@utils/native";
import { translateSettingsText, useSettingsI18n } from "@utils/settingsI18n";
import { GuildMemberStore, React, Select, UserStore } from "@webpack/common";
import BadgeAPI from "plugins/_api/badges";

import { DonateButtonComponent } from "./DonateButton";
import { openNotificationSettingsModal } from "./NotificationSettings";

const DEFAULT_DONATE_IMAGE = "https://cdn.discordapp.com/emojis/1026533090627174460.png";
const SHIGGY_DONATE_IMAGE = "https://equicord.org/assets/favicon.png";

const VENNIE_DONATOR_IMAGE = "https://cdn.discordapp.com/emojis/1238120638020063377.png";
const COZY_CONTRIB_IMAGE = "https://cdn.discordapp.com/emojis/1026533070955872337.png";

const DONOR_BACKGROUND_IMAGE = "https://media.discordapp.net/stickers/1311070116305436712.png?size=2048";
const CONTRIB_BACKGROUND_IMAGE = "https://media.discordapp.net/stickers/1311070166481895484.png?size=2048";

const cl = classNameFactory("vc-vencord-tab-");

type KeysOfType<Object, Type> = {
    [K in keyof Object]: Object[K] extends Type ? K : never;
}[keyof Object];

function EquicordSettings() {
    const t = useSettingsI18n();
    const settings = useSettings();

    const donateImage = React.useMemo(
        () => (Math.random() > 0.5 ? DEFAULT_DONATE_IMAGE : SHIGGY_DONATE_IMAGE),
        [],
    );

    const needsVibrancySettings = IS_DISCORD_DESKTOP && IS_MAC;

    const user = UserStore?.getCurrentUser();

    const Switches: Array<false | {
        key: KeysOfType<typeof settings, boolean>;
        title: string;
        description?: string;
        restartRequired?: boolean;
        warning: { enabled: boolean; message?: string; };
    }
    > = [
            {
                key: "useQuickCss",
                title: t("Enable Custom CSS"),
                description: t("Load custom CSS from the QuickCSS editor. This allows you to customize Discord's appearance with your own styles."),
                restartRequired: true,
                warning: { enabled: false },
            },
            !IS_WEB && {
                key: "enableReactDevtools",
                title: t("Enable React Developer Tools"),
                description: t("Enable the React Developer Tools extension for debugging Discord's React components. Useful for plugin development."),
                restartRequired: true,
                warning: { enabled: false },
            },
            (!IS_WEB && !IS_DISCORD_DESKTOP || !IS_WINDOWS) && {
                key: "mainWindowFrameless",
                title: t("Disable the Main Window Frame"),
                description: t("Remove the native window frame for a cleaner look. You can still move the window by dragging the title bar area."),
                restartRequired: true,
                warning: { enabled: false },
            },
            !IS_WEB &&
            (!IS_DISCORD_DESKTOP || !IS_WINDOWS
                ? {
                    key: "frameless",
                    title: t("Disable All Window Frames"),
                    description: t("Remove the native window frame for a cleaner look. You can still move the window by dragging the title bar area."),
                    restartRequired: true,
                    warning: { enabled: false },
                }
                : {
                    key: "winNativeTitleBar",
                    title: t("Use Windows' native title bar instead of Discord's custom one"),
                    description: t("Replace Discord's custom title bar with the standard Windows title bar. This may improve compatibility with some window management tools."),
                    restartRequired: true,
                    warning: { enabled: false },
                }
            ),
            !IS_WEB && {
                key: "transparent",
                title: t("Enable Window Transparency"),
                description: t("Make the Discord window transparent. A theme that supports transparency is required or this will do nothing."),
                restartRequired: true,
                warning: {
                    enabled: true,
                    message: IS_WINDOWS
                        ? t("This will stop the window from being resizable and prevents you from snapping the window to screen edges.")
                        : t("This will stop the window from being resizable."),
                },
            },
            IS_DISCORD_DESKTOP && {
                key: "disableMinSize",
                title: t("Disable Minimum Window Size"),
                description: t("Allow the Discord window to be resized smaller than its default minimum size. Useful for tiling window managers or small screens."),
                restartRequired: true,
                warning: { enabled: false },
            },
            !IS_WEB &&
            IS_WINDOWS && {
                key: "winCtrlQ",
                title: t("Register Ctrl+Q as shortcut to close Discord"),
                description: t("Add Ctrl+Q as a keyboard shortcut to close Discord. This provides an alternative to Alt+F4 for quickly closing the application."),
                restartRequired: true,
                warning: { enabled: false },
            },
        ];

    return (
        <SettingsTab>
            {(isEquicordDonor(user?.id) || isVencordDonor(user?.id)) ? (
                <SpecialCard
                    title={t("Donations")}
                    subtitle={t("Thank you for donating!")}
                    description={
                        isEquicordDonor(user?.id) && isVencordDonor(user?.id)
                            ? t("All Vencord users can see your Vencord donor badge, and Chocord users can see your Chocord donor badge. To change your Vencord donor badge, contact @vending.machine. For your Chocord donor badge, make a ticket in Chocord's server.")
                            : isVencordDonor(user?.id)
                                ? t("All Vencord users can see your badge! You can manage your perks by messaging @vending.machine.")
                                : t("All Chocord users can see your badge! You can manage your perks by making a ticket in Chocord's server.")
                    }
                    cardImage={VENNIE_DONATOR_IMAGE}
                    backgroundImage={DONOR_BACKGROUND_IMAGE}
                    backgroundColor="#ED87A9"
                >
                    <DonateButtonComponent donated={true} />
                </SpecialCard>
            ) : (
                <SpecialCard
                    title={t("Support the Project")}
                    description={t("Please consider supporting the development of Chocord by donating!")}
                    cardImage={donateImage}
                    backgroundImage={DONOR_BACKGROUND_IMAGE}
                    backgroundColor="#c3a3ce"
                >
                    <DonateButtonComponent />
                </SpecialCard>
            )}
            {isAnyPluginDev(user?.id) && (
                <SpecialCard
                    title={t("Contributions")}
                    subtitle={t("Thank you for contributing!")}
                    description={t("Since you've contributed to Chocord you now have a cool new badge!")}
                    cardImage={COZY_CONTRIB_IMAGE}
                    backgroundImage={CONTRIB_BACKGROUND_IMAGE}
                    backgroundColor="#EDCC87"
                >
                    <Button
                        variant="none"
                        size="medium"
                        type="button"
                        onClick={() => openContributorModal(user)}
                        className="vc-contrib-button"
                    >
                        <GithubIcon aria-hidden fill={"#000000"} className={"vc-contrib-github"} />
                        {t("See what you've contributed to")}
                    </Button>
                </SpecialCard>
            )}

            <Heading className={Margins.top16}>{t("Quick Actions")}</Heading>
            <Paragraph className={Margins.bottom16}>
                {t("Common actions you might want to perform. These shortcuts give you quick access to frequently used features without navigating through menus.")}
            </Paragraph>

            <QuickActionCard>
                <QuickAction
                    Icon={LogIcon}
                    text={t("Notification Log")}
                    action={openNotificationLogModal}
                />
                <QuickAction
                    Icon={PaintbrushIcon}
                    text={t("Edit QuickCSS")}
                    action={() => VencordNative.quickCss.openEditor()}
                />
                {!IS_WEB && (
                    <QuickAction
                        Icon={RestartIcon}
                        text={t("Relaunch Discord")}
                        action={relaunch}
                    />
                )}
                {!IS_WEB && (
                    <QuickAction
                        Icon={FolderIcon}
                        text={t("Open Settings Folder")}
                        action={() => VencordNative.settings.openFolder()}
                    />
                )}
                <QuickAction
                    Icon={GithubIcon}
                    text={t("View Source Code")}
                    action={() =>
                        VencordNative.native.openExternal(
                            "https://github.com/" + gitRemote,
                        )
                    }
                />
            </QuickActionCard>

            <Divider className={Margins.top20} />

            <Heading className={Margins.top20}>{t("Client Settings")}</Heading>
            <Paragraph className={Margins.bottom16}>
                {t("Configure how Chocord behaves and integrates with Discord. These settings affect the Discord client's appearance and behavior.")}
            </Paragraph>
            <Notice.Info className={Margins.bottom20} style={{ width: "100%" }}>
                {t("You can customize where this settings section appears in Discord's settings menu by configuring the")}{" "}
                <a
                    role="button"
                    onClick={() => openPluginModal(plugins.Settings)}
                    style={{ cursor: "pointer", color: "var(--text-link)" }}
                >
                    {t("Settings Plugin")}
                </a>.
            </Notice.Info>

            {Switches.filter((s): s is Exclude<typeof s, false> => !!s).map(
                s => (
                    <FormSwitch
                        key={s.key}
                        value={settings[s.key]}
                        onChange={v => (settings[s.key] = v)}
                        title={s.title}
                        description={
                            s.warning.enabled ? (
                                <>
                                    {s.description}
                                    <Notice.Warning className={Margins.top8} style={{ width: "100%" }}>
                                        {s.warning.message}
                                    </Notice.Warning>
                                </>
                            ) : (
                                s.description
                            )
                        }
                        hideBorder
                    />
                ),
            )}

            {needsVibrancySettings && (
                <>
                    <Divider className={Margins.top20} />

                    <Heading className={Margins.top20}>{t("Window Vibrancy")}</Heading>
                    <Paragraph className={Margins.bottom16}>
                        {t("Customize the macOS window vibrancy effect. This controls the blur and transparency style of the Discord window. Changes require a restart to take effect.")}
                    </Paragraph>
                    <Select
                        className={Margins.bottom20}
                        placeholder={t("Window vibrancy style")}
                        options={[
                            // Sorted from most opaque to most transparent
                            {
                                label: t("No vibrancy"),
                                value: undefined,
                            },
                            {
                                label: t("Under Page (window tinting)"),
                                value: "under-page",
                            },
                            {
                                label: t("Content"),
                                value: "content",
                            },
                            {
                                label: t("Window"),
                                value: "window",
                            },
                            {
                                label: t("Selection"),
                                value: "selection",
                            },
                            {
                                label: t("Titlebar"),
                                value: "titlebar",
                            },
                            {
                                label: t("Header"),
                                value: "header",
                            },
                            {
                                label: t("Sidebar"),
                                value: "sidebar",
                            },
                            {
                                label: t("Tooltip"),
                                value: "tooltip",
                            },
                            {
                                label: t("Menu"),
                                value: "menu",
                            },
                            {
                                label: t("Popover"),
                                value: "popover",
                            },
                            {
                                label: t("Fullscreen UI (transparent but slightly muted)"),
                                value: "fullscreen-ui",
                            },
                            {
                                label: t("HUD (Most transparent)"),
                                value: "hud",
                            },
                        ]}
                        select={v => (settings.macosVibrancyStyle = v)}
                        isSelected={v => settings.macosVibrancyStyle === v}
                        serialize={identity}
                    />
                </>
            )}

            <Divider className={Margins.top20} />

            <Heading className={Margins.top20}>{t("Notifications")}</Heading>
            <Paragraph className={Margins.bottom16}>
                {t("Configure how Chocord handles notifications. You can customize when and how you receive alerts, or view a history of past notifications.")}
            </Paragraph>

            <Flex gap="16px">
                <Button onClick={openNotificationSettingsModal}>
                    {t("Notification Settings")}
                </Button>
                <Button variant="secondary" onClick={openNotificationLogModal}>
                    {t("View Notification Log")}
                </Button>
            </Flex>
        </SettingsTab>
    );
}

export default wrapTab(EquicordSettings, translateSettingsText("Chocord Settings"));

export function isEquicordDonor(userId: string): boolean {
    const donorBadges = BadgeAPI.getEquicordDonorBadges(userId);
    return GuildMemberStore.getMember(GUILD_ID, userId)?.roles.includes(DONOR_ROLE_ID) || !!donorBadges;
}

export function isVencordDonor(userId: string): boolean {
    const donorBadges = BadgeAPI.getDonorBadges(userId);
    return GuildMemberStore.getMember(VC_GUILD_ID, userId)?.roles.includes(VC_DONOR_ROLE_ID) || !!donorBadges;
}
