/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { openNotificationLogModal } from "@api/Notifications/notificationLog";
import { useSettings } from "@api/Settings";
import { BaseText } from "@components/BaseText";
import { Button } from "@components/Button";
import { ErrorCard } from "@components/ErrorCard";
import { Flex } from "@components/Flex";
import { FormSwitch } from "@components/FormSwitch";
import { Heading } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { Margins } from "@utils/margins";
import { identity } from "@utils/misc";
import { ModalCloseButton, ModalContent, ModalHeader, ModalRoot, ModalSize, openModal } from "@utils/modal";
import { translateSettingsText, useSettingsI18n } from "@utils/settingsI18n";
import { Select, Slider } from "@webpack/common";

export function NotificationSection() {
    const t = useSettingsI18n();

    return (
        <section className={Margins.top16}>
            <Heading>{t("Notifications")}</Heading>
            <Paragraph className={Margins.bottom8}>
                {t("Settings for Notifications sent by Vencord. This does NOT include Discord notifications (messages, etc)")}
            </Paragraph>
            <Flex>
                <Button onClick={openNotificationSettingsModal}>
                    {t("Notification Settings")}
                </Button>
                <Button onClick={openNotificationLogModal}>
                    {t("View Notification Log")}
                </Button>
            </Flex>
        </section>
    );
}

export function openNotificationSettingsModal() {
    openModal(props => (
        <ModalRoot {...props} size={ModalSize.MEDIUM}>
            <ModalHeader>
                <BaseText size="lg" weight="semibold" style={{ flexGrow: 1 }}>{translateSettingsText("Notification Settings")}</BaseText>
                <ModalCloseButton onClick={props.onClose} />
            </ModalHeader>

            <ModalContent>
                <NotificationSettings />
            </ModalContent>
        </ModalRoot>
    ));
}

function NotificationSettings() {
    const t = useSettingsI18n();
    const settings = useSettings(["notifications.*"]).notifications;

    return (
        <div style={{ padding: "1em 0" }}>
            <Heading>{t("Notification Style")}</Heading>
            {settings.useNative !== "never" && Notification?.permission === "denied" && (
                <ErrorCard style={{ padding: "1em" }} className={Margins.bottom8}>
                    <Heading>{t("Desktop Notification Permission denied")}</Heading>
                    <Paragraph>{t("You have denied Notification Permissions. Thus, Desktop notifications will not work!")}</Paragraph>
                </ErrorCard>
            )}
            <Paragraph className={Margins.bottom8}>
                {t("Some plugins may show you notifications. These come in two styles:")}
                <ul>
                    <li><strong>{t("Chocord Notifications")}</strong>: {t("These are in-app notifications")}</li>
                    <li><strong>{t("Desktop Notifications")}</strong>: {t("Native Desktop notifications (like when you get a ping)")}</li>
                </ul>
            </Paragraph>
            <Select
                placeholder={t("Notification Style")}
                options={[
                    { label: t("Only use Desktop notifications when Discord is not focused"), value: "not-focused", default: true },
                    { label: t("Always use Desktop notifications"), value: "always" },
                    { label: t("Always use Chocord notifications"), value: "never" },
                ] satisfies Array<{ value: typeof settings["useNative"]; } & Record<string, any>>}
                closeOnSelect={true}
                select={v => settings.useNative = v}
                isSelected={v => v === settings.useNative}
                serialize={identity}
            />

            <Heading className={Margins.top16 + " " + Margins.bottom8}>{t("Notification Position")}</Heading>
            <Select
                isDisabled={settings.useNative === "always"}
                placeholder={t("Notification Position")}
                options={[
                    { label: t("Bottom Right"), value: "bottom-right", default: true },
                    { label: t("Top Right"), value: "top-right" },
                ] satisfies Array<{ value: typeof settings["position"]; } & Record<string, any>>}
                select={v => settings.position = v}
                isSelected={v => v === settings.position}
                serialize={identity}
            />

            <Heading className={Margins.top16 + " " + Margins.bottom8}>{t("Missed Notification Count")}</Heading>
            <FormSwitch
                title={t("When refocusing discord a notification will popup with how you missed")}
                value={settings.missed}
                onChange={(v: boolean) => settings.missed = v}
            />

            <Heading className={Margins.top16 + " " + Margins.bottom8}>{t("Notification Timeout")}</Heading>
            <Paragraph className={Margins.bottom16}>{t("Set to 0s to never automatically time out")}</Paragraph>
            <Slider
                disabled={settings.useNative === "always"}
                markers={[0, 1000, 2500, 5000, 10_000, 20_000]}
                minValue={0}
                maxValue={20_000}
                initialValue={settings.timeout}
                onValueChange={v => settings.timeout = v}
                onValueRender={v => (v / 1000).toFixed(2) + "s"}
                onMarkerRender={v => (v / 1000) + "s"}
                stickToMarkers={false}
            />

            <Heading className={Margins.top16 + " " + Margins.bottom8}>{t("Notification Log Limit")}</Heading>
            <Paragraph className={Margins.bottom16}>
                {t("The amount of notifications to save in the log until old ones are removed. Set to 0 to disable Notification log and ∞ to never automatically remove old Notifications")}
            </Paragraph>
            <Slider
                markers={[0, 25, 50, 75, 100, 200]}
                minValue={0}
                maxValue={200}
                stickToMarkers={true}
                initialValue={settings.logLimit}
                onValueChange={v => settings.logLimit = v}
                onValueRender={v => v === 200 ? "∞" : v}
                onMarkerRender={v => v === 200 ? "∞" : v}
            />
        </div>
    );
}
