/**
 * @name GameTimeTracker
 * @version 1.2.3
 * @description Track time spent in games
 * @license MIT
 * @author Yentis
 * @authorId 68834122860077056
 * @website https://github.com/Yentis/betterdiscord-game-time-tracker
 * @source https://raw.githubusercontent.com/Yentis/betterdiscord-game-time-tracker/master/GameTimeTracker.plugin.js
 */
'use strict';

// プラグインの更新履歴
const PLUGIN_CHANGELOG = [
  {
    title: '1.2.3',
    type: 'fixed',
    items: ['playtimesummaryコマンドの動作を修正'],
  },
];

const SETTINGS_KEY = 'settings'; // 設定を保存するキー
const CURRENT_VERSION_INFO_KEY = 'currentVersionInfo'; // バージョン情報を保存するキー
const DEFAULT_SETTINGS = {
  games: {}, // 記録するゲームデータの状態
};

// ユーティリティ（便利機能）クラス
class Utils {
  // 設定項目の作成
  static SettingItem(options) {
    return {
      ...options,
      type: 'custom',
    };
  }

  // オブジェクトかどうかの判定
  static isObject(object) {
    return typeof object === 'object' && !!object && !Array.isArray(object);
  }

  // プレイ時間を目で見て分かりやすい 「○時間 ○分 ○秒」 の形式に変換する
  static humanReadablePlaytime(playtimeSeconds) {
    let seconds = playtimeSeconds;

    const hours = Math.floor(seconds / 3600);
    seconds -= hours * 3600;

    const minutes = Math.floor(seconds / 60);
    seconds -= minutes * 60;

    return `${hours}時間 ${minutes}分 ${seconds}秒`;
  }

  static getSortedGames(games) {
    return Object.values(games).sort((a, b) => b.playtimeSeconds - a.playtimeSeconds);
  }

  static createPlaytimeSummary(games) {
    const sortedGames = Utils.getSortedGames(games);
    if (sortedGames.length <= 0) {
      return 'ゲーム履歴がありません';
    }

    const totalPlaytimeSeconds = sortedGames.reduce((partialSum, game) => partialSum + game.playtimeSeconds, 0);
    const allGames = sortedGames.concat([
      {
        name: '---------\n合計',
        playtimeSeconds: totalPlaytimeSeconds,
      },
    ]);

    return allGames
      .map((game) => `${game.name} - ${Utils.humanReadablePlaytime(game.playtimeSeconds)}`)
      .join('\n');
  }
}

// 各機能の基盤となる共通クラス
class BaseService {
  plugin;
  bdApi;
  logger;

  constructor(plugin) {
    this.plugin = plugin;
    this.bdApi = this.plugin.bdApi;
    this.logger = this.bdApi.Logger;
  }
}

class SettingsService extends BaseService {
  static TRASH_ICON =
    '<svg class="" fill="#FFFFFF" viewBox="0 0 24 24" ' +
    'style="width: 20px; height: 20px;"><path fill="none" d="M0 0h24v24H0V0z"></path>' +
    '<path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zm2.46-7.12l1.41-1.41L12 12.59l2.12-2.' +
    '12 1.41 1.41L13.41 14l2.12 2.12-1.41 1.41L12 15.41l-2.12 2.12-1.41-1.41L10.59 14l-2.13-2.1' +
    '2zM15.5 4l-1-1h-5l-1 1H5v2h14V4z"></path><path fill="none" d="M0 0h24v24H0z"></path></svg>';

  settings = DEFAULT_SETTINGS;

  start() {
    const savedSettings = this.bdApi.Data.load(SETTINGS_KEY);
    this.settings = Object.assign({}, DEFAULT_SETTINGS, savedSettings);

    return Promise.resolve();
  }

  getSettingsElement() {
    const { React, UI } = this.bdApi;
    const settings = [];
    const summaryCopyButton = React.createElement(
      'button',
      {
        id: 'GTT-CopySummary',
        className: 'bd-button bd-button-filled bd-button-color-brand',
        onClick: () => {
          const content = Utils.createPlaytimeSummary(this.settings.games);
          DiscordNative.clipboard.copy(content);
          UI.showToast('プレイ時間サマリーをクリップボードにコピーしました', { type: 'success' });
        },
      },
      'サマリーをコピー'
    );

    settings.push(
      Utils.SettingItem({
        id: 'summaryActions',
        name: 'プレイ時間サマリー',
        note: '現在の記録をテキストでコピーできます。',
        children: [summaryCopyButton],
      })
    );

    Object.entries(this.settings.games)
      .reverse()
      .sort(([_aKey, aGame], [_bKey, bGame]) => (bGame.lastPlayed ?? 0) - (aGame.lastPlayed ?? 0))
      .forEach(([id, game]) => {
        const elementId = `GTT-Game-${id}`;
        const deleteButton = React.createElement('button', {
          id: elementId,
          className: 'bd-button bd-button-filled bd-button-color-red',
          dangerouslySetInnerHTML: { __html: SettingsService.TRASH_ICON },
          onClick: () => {
            delete this.settings.games[id];
            this.bdApi.Data.save(SETTINGS_KEY, this.settings);

            const element = document.getElementById(elementId);
            if (!element) return;

            const gameContainer = element.closest('.bd-setting-item');
            gameContainer?.remove();
          },
        });

        const settingItem = Utils.SettingItem({
          id: elementId,
          name: game.name,
          note: Utils.humanReadablePlaytime(game.playtimeSeconds),
          children: [deleteButton],
        });

        settings.push(settingItem);
      });

    if (settings.length <= 0) {
      const setting = Utils.SettingItem({
        id: 'noGames',
        name: 'ゲーム履歴がありません',
        note: 'ゲームをプレイして時間を記録しましょう！',
        children: [],
      });

      settings.push(setting);
    }

    return UI.buildSettingsPanel({
      settings,
      onChange: () => {
        this.bdApi.Data.save(SETTINGS_KEY, this.settings);
      },
    });
  }

  stop() {
    // Do nothing
  }
}

// Discord内部のモジュールを取得・管理するためのサービス
class ModulesService extends BaseService {
  dispatcher;
  messageModule;
  channelModule;

  start() {
    this.dispatcher =
      BdApi.Webpack.getModule(BdApi.Webpack.Filters.byKeys('dispatch', 'subscribe'), {
        searchExports: true,
      }) ??
      BdApi.Webpack.getByKeys('dispatch', 'subscribe');

    this.messageModule =
      BdApi.Webpack.getModule(BdApi.Webpack.Filters.byKeys('sendMessage', 'sendBotMessage')) ??
      BdApi.Webpack.getByKeys('sendMessage', 'sendBotMessage');

    this.channelModule =
      BdApi.Webpack.getStore('SelectedChannelStore') ??
      BdApi.Webpack.getByKeys('getCurrentlySelectedChannelId');

    Object.entries(this).forEach(([key, value]) => {
      if (value !== undefined && value !== null) return;
      this.logger.error(`${key} not found!`);
    });

    return Promise.resolve();
  }

  stop() {
    // Do nothing
  }
}

// 起動中・プレイ中のゲーム状態を追跡するサービス
class GameService extends BaseService {
  modulesService;
  settingsService;

  gameStartTimes = {};

  onRunningGamesChange = (event) => {
    if (event === undefined) return;
    this.logger.debug('Games changed:', event);

    const data = event;

    if (data.added.length > 0) {
      data.added.forEach((game) => {
        this.gameStartTimes[game.exeName] = game.start ?? new Date().getTime();
      });
    }

    if (data.removed.length <= 0) {
      return;
    }

    const games = this.settingsService.settings.games;
    data.removed.forEach((game) => {
      const startTime = game.start ?? this.gameStartTimes[game.exeName];
      if (startTime === undefined) {
        this.logger.warn(`Game ${game.name} closed but start time is unknown`);
        return;
      }

      const id = game.exeName;
      const playtimeSeconds = Math.max(0, (new Date().getTime() - startTime) / 1000);
      this.logger.info(`Played ${game.name} for ${playtimeSeconds} seconds`);

      const trackedGame = games[id] ?? { name: game.name, playtimeSeconds: 0 };
      trackedGame.name = game.name;
      trackedGame.playtimeSeconds += Math.round(playtimeSeconds);
      trackedGame.lastPlayed = Date.now();
      games[id] = trackedGame;
    });

    this.bdApi.Data.save(SETTINGS_KEY, this.settingsService.settings);
  };

  start(modulesService, settingsService) {
    this.modulesService = modulesService;
    this.settingsService = settingsService;

    if (!modulesService.dispatcher || typeof modulesService.dispatcher.subscribe !== 'function') {
      this.logger.error('dispatcher.subscribe is unavailable. Game tracking is disabled.');
      return Promise.resolve();
    }

    modulesService.dispatcher.subscribe('RUNNING_GAMES_CHANGE', this.onRunningGamesChange);

    return Promise.resolve();
  }

  stop() {
    if (!this.modulesService?.dispatcher || typeof this.modulesService.dispatcher.unsubscribe !== 'function') {
      return;
    }

    this.modulesService.dispatcher.unsubscribe('RUNNING_GAMES_CHANGE', this.onRunningGamesChange);
  }
}

// チャットコマンド機能（/playtimesummary など）を管理するサービス
class CommandsService extends BaseService {
  start(modulesService, settingsService) {
    const command = {
      id: 'PlayTimeSummary',
      name: 'playtimesummary',
      description: 'GameTimeTrackerのプレイ時間サマリーを送信します',
      options: [
        {
          name: 'type',
          description: 'サマリーの送信先・表示方法',
          required: true,
          type: this.bdApi.Commands.Types.OptionTypes.STRING,
          choices: [
            {
              name: 'clipboard',
              value: 'clipboard',
            },
            {
              name: 'message',
              value: 'message',
            },
            {
              name: 'clyde',
              value: 'clyde',
            },
          ],
        },
      ],
      execute: (event) => {
        try {
          const channelId = modulesService.channelModule?.getCurrentlySelectedChannelId?.() ?? '';
          if (!channelId) return;

          const content = Utils.createPlaytimeSummary(settingsService.settings.games);

          const type = event[0]?.value ?? 'message';

          if (type === 'message') {
            modulesService.messageModule?.sendMessage?.(channelId, {
              content,
              invalidEmojis: [],
              tts: false,
              validNonShortcutEmojis: [],
            });
          } else if (type === 'clipboard') {
            DiscordNative.clipboard.copy(content);
          } else if (type === 'clyde') {
            modulesService.messageModule?.sendBotMessage?.(channelId, content);
          }
        } catch (error) {
          this.logger.error(error);
        }
      },
    };

    this.bdApi.Commands.register(command);

    return Promise.resolve();
  }

  stop() {
    this.bdApi.Commands.unregisterAll();
  }
}

// プラグインのメインクラス
class GameTimeTrackerPlugin {
  settingsService;
  modulesService;
  commandsService;
  gameService;

  meta;
  bdApi;
  logger;

  constructor(meta) {
    this.meta = meta;
    this.bdApi = new BdApi(this.meta.name);
    this.logger = this.bdApi.Logger;
  }

  start() {
    this.doStart().catch((error) => {
      this.logger.error(error);
    });
  }

  async doStart() {
    this.showChangelogIfNeeded();
    await this.startServices();
  }

  showChangelogIfNeeded() {
    const currentVersionInfo = this.bdApi.Data.load(CURRENT_VERSION_INFO_KEY) ?? {};
    const UI = this.bdApi.UI;

    // バージョンアップ時に更新履歴ダイアログを自動で1度だけ表示する
    if (currentVersionInfo.hasShownChangelog !== true || currentVersionInfo.version !== this.meta.version) {
      UI.showChangelogModal({
        title: `${this.meta.name} 更新履歴`,
        changes: PLUGIN_CHANGELOG,
      });

      const newVersionInfo = {
        version: this.meta.version,
        hasShownChangelog: true,
      };

      this.bdApi.Data.save(CURRENT_VERSION_INFO_KEY, newVersionInfo);
    }
  }

  async startServices() {
    this.settingsService = new SettingsService(this);
    await this.settingsService.start();

    this.modulesService = new ModulesService(this);
    await this.modulesService.start();

    this.commandsService = new CommandsService(this);
    await this.commandsService.start(this.modulesService, this.settingsService);

    this.gameService = new GameService(this);
    await this.gameService.start(this.modulesService, this.settingsService);
  }

  getSettingsPanel() {
    return this.settingsService?.getSettingsElement() ?? BdApi.React.createElement('div');
  }

  stop() {
    this.gameService?.stop();
    this.gameService = undefined;

    this.commandsService?.stop();
    this.commandsService = undefined;

    this.modulesService?.stop();
    this.modulesService = undefined;

    this.settingsService?.stop();
    this.settingsService = undefined;
  }
}

module.exports = GameTimeTrackerPlugin;
