#!/usr/bin/node
/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2026 Vendicated and contributors
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

// @ts-check

import { execSync } from "child_process";
import { cp, mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";

import Zip from "zip-local";

if (process.platform !== "win32")
    throw new Error("This command only supports Windows.");

const DIST_DIR = "dist";
const DESKTOP_DIR = join(DIST_DIR, "desktop");
const INSTALLER_EXE = join(DIST_DIR, "Installer", "EquilotlCli.exe");
const BUNDLE_DIR = join(DIST_DIR, "windows-bundle");
const OUTPUT_ZIP = join(DIST_DIR, "Chocord-windows-bundle.zip");

const runCommand = command => {
    console.info("> " + command);
    execSync(command, {
        stdio: "inherit"
    });
};

runCommand("pnpm buildStandalone");
runCommand("node scripts/runInstaller.mjs -- --help");

await rm(BUNDLE_DIR, { recursive: true, force: true });
await rm(OUTPUT_ZIP, { force: true });
await mkdir(BUNDLE_DIR, { recursive: true });

await cp(DESKTOP_DIR, join(BUNDLE_DIR, "desktop"), { recursive: true });
await cp(INSTALLER_EXE, join(BUNDLE_DIR, "EquilotlCli.exe"));

const writeBatch = (name, action) => writeFile(join(BUNDLE_DIR, name), [
    "@echo off",
    "setlocal",
    "set \"SCRIPT_DIR=%~dp0\"",
    "set \"EQUICORD_USER_DATA_DIR=%SCRIPT_DIR%\"",
    "set \"EQUICORD_DIRECTORY=%SCRIPT_DIR%desktop\"",
    "set \"EQUICORD_DEV_INSTALL=1\"",
    "\"%SCRIPT_DIR%EquilotlCli.exe\" " + action + " %*",
    "set \"EXIT_CODE=%ERRORLEVEL%\"",
    "endlocal & exit /b %EXIT_CODE%",
    ""
].join("\r\n"));

await Promise.all([
    writeBatch("Install-Chocord.bat", "-install"),
    writeBatch("Uninstall-Chocord.bat", "-uninstall"),
    writeBatch("Repair-Chocord.bat", "-repair"),
    writeFile(join(BUNDLE_DIR, "README.txt"), [
        "Chocord Windows bundle (Equilotl included)",
        "",
        "1. Run Install-Chocord.bat to install Chocord into Discord.",
        "2. Run Repair-Chocord.bat to repair an existing install.",
        "3. Run Uninstall-Chocord.bat to remove Chocord.",
        "",
        "You can pass any Equilotl CLI flags to these scripts.",
        "Example: Install-Chocord.bat -branch canary",
        ""
    ].join("\r\n"))
]);

Zip.sync.zip(BUNDLE_DIR).compress().save(OUTPUT_ZIP);

console.info("Bundle written to " + BUNDLE_DIR);
console.info("Zip archive written to " + OUTPUT_ZIP);
