﻿/*
 * This file is part of SmartProxy <https://github.com/salarcode/SmartProxy>,
 * Copyright (C) 2025 Salar Khalilzadeh <salar2k@gmail.com>
 *
 * SmartProxy is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3 as
 * published by the Free Software Foundation.
 *
 * SmartProxy is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with SmartProxy.  If not, see <http://www.gnu.org/licenses/>.
 */
import { api } from "../lib/environment";
import { PolyFill } from "../lib/PolyFill";
import { Debug } from "../lib/Debug";
import { Settings } from "./Settings";
import { Utils } from "../lib/Utils";
import { GeneralOptions, ProxyServer, ProxyServerFromSubscription, ProxyServerSubscription, SettingsConfig, SmartProfile, UpdateInfo } from "./definitions";
import { ProxyEngine } from "./ProxyEngine";
import { ProxyRules } from "./ProxyRules";
import { SubscriptionUpdater } from "./SubscriptionUpdater";
import { ProfileOperations } from "./ProfileOperations";
import { createClient } from "webdav";

const subscriptionUpdaterLib = SubscriptionUpdater;
const proxyEngineLib = ProxyEngine;
const polyFillLib = PolyFill;
const utilsLib = Utils;

export class SettingsOperation {

	public static getStrippedSyncableSettings(settings: SettingsConfig): SettingsConfig {
		/** Returns a copy of settings with only syncable settings. */

		// deep clone required
		let settingsCopy: SettingsConfig = JSON.parse(JSON.stringify(settings));

		settingsCopy.options.syncWebDavServerUrl = '';
		settingsCopy.options.syncWebDavBackupFilename = '';
		settingsCopy.options.syncWebDavServerUser = '';
		settingsCopy.options.syncWebDavServerPassword = '';

		if (settingsCopy.proxyProfiles && settingsCopy.proxyProfiles.length) {
			for (const profile of settingsCopy.proxyProfiles) {
				if (profile.rulesSubscriptions && profile.rulesSubscriptions.length) {
					for (const subscription of profile.rulesSubscriptions) {
						subscription.proxyRules = [];
						subscription.whitelistRules = [];
					}
				}
			}
		}
		if (settingsCopy.proxyServerSubscriptions && settingsCopy.proxyServerSubscriptions.length)
			for (const subscription of settingsCopy.proxyServerSubscriptions) {
				subscription.proxies = []
			}

		return settingsCopy;
	}
	public static copyNonSyncableSettings(destSettings: SettingsConfig, sourceSettings: SettingsConfig) {
		/** Copies non-syncable settings. Can be used to copy from local settings to newly received synced data. */
		if (destSettings.proxyProfiles && destSettings.proxyProfiles.length)
			for (const destProfile of destSettings.proxyProfiles) {
				if (destProfile.rulesSubscriptions && destProfile.rulesSubscriptions.length) {
					for (const destSubscription of destProfile.rulesSubscriptions) {
						if (!destSubscription.enabled)
							continue;

						let srcProfile = sourceSettings.proxyProfiles.find(x => x.profileId == destProfile.profileId);
						if (!srcProfile)
							continue;

						let srcSubscription = srcProfile.rulesSubscriptions.find(x => x.id == destSubscription.id);
						if (!srcSubscription)
							continue;

						if (srcSubscription.proxyRules && srcSubscription.proxyRules.length)
							destSubscription.proxyRules = srcSubscription.proxyRules;
						else
							destSubscription.proxyRules = destSubscription.proxyRules || [];

						if (srcSubscription.whitelistRules && srcSubscription.whitelistRules.length)
							destSubscription.whitelistRules = srcSubscription.whitelistRules;
						else
							destSubscription.whitelistRules = destSubscription.whitelistRules || [];
					}
				}
			}


		if (destSettings.proxyServerSubscriptions && destSettings.proxyServerSubscriptions.length)
			for (const destSubscription of destSettings.proxyServerSubscriptions) {

				let srcSubscription = sourceSettings.proxyServerSubscriptions.find(x => x.name == destSubscription.name && x.url == destSubscription.url);
				if (!srcSubscription) {
					destSubscription.proxies = [];
					continue;
				}

				if (srcSubscription.proxies && srcSubscription.proxies.length)
					destSubscription.proxies = srcSubscription.proxies;
				else
					destSubscription.proxies ||= [];
			}
	}

	public static getBackupOfSettings(settings: SettingsConfig): SettingsConfig {
		let settingsCopy = SettingsOperation.getStrippedSyncableSettings(settings);
		settingsCopy.configVersion = undefined;
		settingsCopy.syncHash = undefined;

		return settingsCopy;
	}

	public static readSyncedSettings(success: Function) {
		// Note: At this point, we are assuming that sync is enabled in the settings.

		// getting synced data
		polyFillLib.storageSyncGet(null,
			onGetSyncData,
			onGetSyncError);

		function onGetSyncData(data: any) {
			try {
				let syncedSettings = utilsLib.decodeSyncData(data);

				// only if sync settings is enabled
				if (syncedSettings &&
					syncedSettings.options) {

					if (syncedSettings.syncHash == Settings.current.syncHash) {
						Debug.log(`SyncHash is same, ignoring the sync data.`, Settings.current.syncHash);
						return;
					}

					me.applySyncSettings(syncedSettings);

					if (success)
						success();
				}
			} catch (e) {
				Debug.error(`SettingsOperation.readSyncedSettings> onGetSyncData error: ${e} \r\n`, JSON.stringify(data));
			}
		}

		function onGetSyncError(error: any) {
			Debug.error(`SettingsOperation.readSyncedSettings error: ${error.message}`);
		}
	}

	public static applySyncSettings(restoredSyncedSettings: SettingsConfig) {
		if (!restoredSyncedSettings) {
			return;
		}

		// use synced settings
		restoredSyncedSettings = Settings.getRestorableSettings(restoredSyncedSettings);
		me.revertSyncOptions(restoredSyncedSettings);
		me.copyNonSyncableSettings(restoredSyncedSettings, Settings.current);

		Settings.current = restoredSyncedSettings;

		Settings.updateActiveSettings();
	}

	/** In local options if sync is disabled for these particular options, don't update them from sync server */
	private static revertSyncOptions(syncedConfig: SettingsConfig) {
		let settings = Settings.current;

		syncedConfig.options.syncSettings = settings.options.syncSettings;
		syncedConfig.options.syncActiveProxy = settings.options.syncActiveProxy;
		syncedConfig.options.syncActiveProfile = settings.options.syncActiveProfile;

		if (!settings.options.syncActiveProxy) {
			syncedConfig.defaultProxyServerId = settings.defaultProxyServerId;
		}
		if (!settings.options.syncActiveProfile) {
			syncedConfig.activeProfileId = settings.activeProfileId;
		}

		syncedConfig.options.syncWebDavServerEnabled = settings.options.syncWebDavServerEnabled;
		syncedConfig.options.syncWebDavServerUrl = settings.options.syncWebDavServerUrl;
		syncedConfig.options.syncWebDavBackupFilename = settings.options.syncWebDavBackupFilename;
		syncedConfig.options.syncWebDavServerUser = settings.options.syncWebDavServerUser;
		syncedConfig.options.syncWebDavServerPassword = settings.options.syncWebDavServerPassword;
	}

	public static findProxyServerByIdFromList(id: string, proxyServers: ProxyServer[], proxyServerSubs: ProxyServerSubscription[]): ProxyServer {
		if (proxyServers) {
			let proxy = proxyServers.find(item => item.id === id);
			if (proxy !== undefined)
				return proxy;
		}

		if (proxyServerSubs)
			for (let subscription of proxyServerSubs) {
				let proxy = subscription.proxies.find(item => item.id === id);
				if (proxy !== undefined)
					return proxy;
			}

		return null;
	}

	public static findProxyServerByName(name: string): ProxyServer {
		let proxy = Settings.current.proxyServers.find(item => item.name === name);
		if (proxy !== undefined)
			return proxy;

		for (let subscription of Settings.current.proxyServerSubscriptions) {
			proxy = subscription.proxies.find(item => item.name === name);
			if (proxy !== undefined)
				return proxy;
		}

		return null;
	}

	public static findProxyServerById(id: string): ProxyServer {
		let proxy = Settings.current.proxyServers.find(item => item.id === id);
		if (proxy !== undefined)
			return proxy;

		for (let subscription of Settings.current.proxyServerSubscriptions) {
			proxy = subscription.proxies.find(item => item.id === id);
			if (proxy !== undefined)
				return proxy;
		}

		return null;
	}

	public static sortProxyServers(proxyServers: ProxyServer[]) {
		if (!proxyServers)
			return;
		proxyServers.sort((a, b) => {
			if ((a.order ?? 0) > (b.order ?? 0))
				return 1;
			if ((a.order ?? 0) < (b.order ?? 0))
				return -1;
			return 0;
		});
	}

	public static getAllSubscribedProxyServers(): ProxyServerFromSubscription[] {

		if (!Settings.current.proxyServerSubscriptions || !Settings.current.proxyServerSubscriptions.length)
			return [];
		let result: ProxyServerFromSubscription[] = [];

		for (let subscription of Settings.current.proxyServerSubscriptions) {
			if (subscription.enabled) {
				let proxiesFromSubscription: ProxyServerFromSubscription[] = subscription.proxies.map(proxy => {
					return { ...proxy, subscriptionName: subscription.name } as ProxyServerFromSubscription;
				});

				result = result.concat(proxiesFromSubscription);
			}
		}
		return result;
	}

	public static getFirstProxyServer(): ProxyServer {
		let settings = Settings.current;

		if (settings.proxyServers && settings.proxyServers.length) {
			return settings.proxyServers[0];
		}
		if (settings.proxyServerSubscriptions)
			for (const subscription of settings.proxyServerSubscriptions) {
				if (subscription.proxies && subscription.proxies.length) {
					return subscription.proxies[0];
				}
			}
		return null;
	}

	public static getLastProxyServer(): ProxyServer {
		let settings = Settings.current;

		if (settings.proxyServers && settings.proxyServers.length) {
			return settings.proxyServers[settings.proxyServers.length - 1];
		}

		if (settings.proxyServerSubscriptions) {
			for (let i = settings.proxyServerSubscriptions.length - 1; i >= 0; i--) {
				const subscription = settings.proxyServerSubscriptions[i];

				if (subscription.proxies && subscription.proxies.length) {
					return subscription.proxies[subscription.proxies.length - 1];
				}
			}
		}
		return null;
	}

	public static findNextProxyServerByCurrentProxyId(currentProxyId: string): ProxyServer {
		let settings = Settings.current;

		let proxyIndex = settings.proxyServers.findIndex(item => item.id === currentProxyId);
		if (proxyIndex > -1 && proxyIndex + 1 < settings.proxyServers.length) {
			return settings.proxyServers[proxyIndex + 1];
		}

		for (let subscription of Settings.current.proxyServerSubscriptions) {
			proxyIndex = subscription.proxies.findIndex(item => item.id === currentProxyId);
			if (proxyIndex > -1 && proxyIndex + 1 < subscription.proxies.length) {
				return subscription.proxies[proxyIndex + 1];
			}
		}
		return null;
	}

	public static findPreviousProxyServerByCurrentProxyId(currentProxyId: string): ProxyServer {
		let settings = Settings.current;

		let proxyIndex = settings.proxyServers.findIndex(item => item.id === currentProxyId);
		if (proxyIndex > 0) {
			return settings.proxyServers[proxyIndex - 1];
		}

		for (let subscription of Settings.current.proxyServerSubscriptions) {
			proxyIndex = subscription.proxies.findIndex(item => item.id === currentProxyId);
			if (proxyIndex > 0) {
				return subscription.proxies[proxyIndex - 1];
			}
		}
		return null;
	}

	public static syncOnChanged(changes: any, area: string) {
		if (area !== "sync") return;

		if (!Settings.current.options.syncSettings) {
			Debug.log("Sync is disabled, ignoring browser syncOnChanged. ", area, changes);
			return;
		}

		if (Settings.current.options.syncWebDavServerEnabled) {
			// WebDav sync is enabled, ignore the sync changes
			Debug.log("Ignoring browser syncOnChanged. WebDav sync is enabled.", area, changes);
			return;
		}
		Debug.log("syncOnChanged ", area, changes);

		// read all the settings
		SettingsOperation.readSyncedSettings(() => {
			// on settings read success

			// force to save changes to local
			SettingsOperation.saveAllLocal(true);

			// Compile rules & Updates Firefox/Chrome proxy configurations
			proxyEngineLib.notifyProxyRulesChanged();

			// reload the subscriptions
			subscriptionUpdaterLib.reloadEmptyServerSubscriptions();
			subscriptionUpdaterLib.reloadEmptyRulesSubscriptions();
		});
	}
	public static saveAllSync(saveToSyncServer: boolean = true) {

		Settings.current.syncHash = Utils.getNewUniqueIdString();
		// before anything save everything in local
		me.saveAllLocal(true);

		if (!saveToSyncServer)
			return;

		if (!Settings.current.options.syncSettings) {
			return;
		}

		const current = Settings.current;
		var strippedSettings = me.getStrippedSyncableSettings(current);

		if (current.options.syncWebDavServerEnabled && current.options.syncWebDavServerUrl) {
			me.saveToWebDavServer(
				current.options.syncWebDavServerUrl,
				current.options.syncWebDavBackupFilename,
				current.options.syncWebDavServerUser,
				current.options.syncWebDavServerPassword,
				strippedSettings);
		}
		else {
			// Sync to browser servers

			let saveObject = utilsLib.encodeSyncData(strippedSettings);
			try {
				polyFillLib.storageSyncSet(saveObject,
					() => {
						Debug.log(`SettingsOperation.saveAllSync: Settings saved to sync storage successfully.`, saveObject);
					},
					(error: Error) => {
						Debug.error(`SettingsOperation.saveAllSync error: ${error.message} `, saveObject);
					});

			} catch (e) {
				Debug.error(`SettingsOperation.saveAllSync error: ${e}`);
			}
		}
	}
	public static saveToWebDavServer(
		serverUrl: string,
		backupFilename: string,
		serverUser: string,
		serverPassword: string,
		settingsToSave: SettingsConfig = null,
		onSuccess: Function = null,
		onError: Function = null
	) {
		var strippedSettings = settingsToSave ?? me.getStrippedSyncableSettings(Settings.current);

		const backupContent = JSON.stringify(strippedSettings);
		const fileName = backupFilename || "smartproxy_settings.json";

		let webDav = createClient(serverUrl, {
			username: serverUser,
			password: serverPassword
		});

		webDav.putFileContents(fileName, backupContent, { overwrite: true })
			.then(() => {
				Debug.log(`Backup uploaded to WebDav as ${fileName}`);
				if (onSuccess) {
					onSuccess();
				}
			})
			.catch(error => {
				Debug.error(`WebDav backup failed: ${error}`);
				if (onError) {
					onError(error);
				}
			});
	}

	public static readFromWebDavServer(
		serverUrl: string,
		backupFilename: string,
		serverUser: string,
		serverPassword: string,
		onSuccess: Function = null,
		onError: Function = null) {
		if (!onSuccess)
			return;

		let webDav = createClient(serverUrl, {
			username: serverUser,
			password: serverPassword
		});
		const fileName = backupFilename || "smartproxy_settings.json";

		webDav.getFileContents(fileName, { format: "text" })
			.then((data: string) => {
				try {
					const restoredSettings = JSON.parse(data) as SettingsConfig;
					if (!restoredSettings)
						throw new Error("Invalid data received from WebDav server.");

					onSuccess(restoredSettings);
				}
				catch (e) {
					Debug.error(`SettingsOperation.readFromWebDavServer error: ${e}`);
					if (onError) {
						onError(e);
					}
					return;
				}
			})
			.catch(error => {
				Debug.error(`WebDav backup failed: ${error}`);
				if (onError) {
					onError(error);
				}
			});
	}

	public static saveAllLocal(forceSave: boolean = false) {
		if (!forceSave && Settings.current.options.syncSettings)
			// don't save in local when sync enabled
			return;

		polyFillLib.storageLocalSet(Settings.current,
			null,
			(error: Error) => {
				Debug.error(`SettingsOperation.saveAllLocal error:`, error);
			});
	}
	public static saveOptions() {
		if (Settings.current.options.syncSettings)
			// don't save in local when sync enabled
			return;

		polyFillLib.storageLocalSet({ options: Settings.current.options },
			null,
			(error: Error) => {
				Debug.error(`SettingsOperation.saveOptions error: ${error.message}`);
			});
	}
	public static saveSmartProfiles() {
		if (Settings.current.options.syncSettings)
			// don't save in local when sync enabled
			return;

		polyFillLib.storageLocalSet({ proxyProfiles: Settings.current.proxyProfiles },
			null,
			(error: Error) => {
				Debug.error(`SettingsOperation.saveProxyProfiles error: ${error.message}`);
			});
	}
	public static saveProxyServers() {
		if (Settings.current.options.syncSettings)
			// don't save in local when sync enabled
			return;

		polyFillLib.storageLocalSet({ proxyServers: Settings.current.proxyServers },
			null,
			(error: Error) => {
				Debug.error(`SettingsOperation.saveRules error: ${error.message}`);
			});
	}
	public static saveProxyServerSubscriptions() {
		if (Settings.current.options.syncSettings)
			// don't save in local when sync enabled
			return;

		polyFillLib.storageLocalSet({ proxyServerSubscriptions: Settings.current.proxyServerSubscriptions },
			null,
			(error: Error) => {
				Debug.error(`SettingsOperation.proxyServerSubscriptions error: ${error.message}`);
			});
	}
	public static saveDefaultProxyServer() {
		if (Settings.current.options.syncSettings)
			// don't save in local when sync enabled
			return;

		polyFillLib.storageLocalSet({ defaultProxyServerId: Settings.current.defaultProxyServerId },
			null,
			(error: Error) => {
				Debug.error(`SettingsOperation.saveDefaultProxyServer error: ${error.message}`);
			});
	}
	public static saveActiveProfile() {
		if (Settings.current.options.syncSettings)
			// don't save in local when sync enabled
			return;

		polyFillLib.storageLocalSet({ activeProfileId: Settings.current.activeProfileId },
			null,
			(error: Error) => {
				Debug.error(`SettingsOperation.saveActiveProfile error: ${error.message}`);
			});
	}
	public static saveUpdateInfo(updateInfo: UpdateInfo) {
		Settings.current.updateInfo = updateInfo;
		me.saveAllSync();
	}

	/** Updates the `proxy server` used in the proxy rules for all SmartProfiles*/
	public static updateSmartProfilesRulesProxyServer() {
		const proxyServers = Settings.current.proxyServers;
		const proxyServerSubs = Settings.current.proxyServerSubscriptions;
		const profiles = Settings.current.proxyProfiles;

		for (const profile of profiles) {
			if (!profile.proxyRules)
				continue;
			for (const rule of profile.proxyRules) {
				if (!rule.proxyServerId) {
					rule.proxy = null;
					continue;
				}
				let proxyServer = SettingsOperation.findProxyServerByIdFromList(
					rule.proxyServerId,
					proxyServers,
					proxyServerSubs
				)
				if (proxyServer) {
					rule.proxy = proxyServer;
				}
				else {
					rule.proxy = null;
					rule.proxyServerId = null;
				}
			}
		}
	}
	public static restoreBackup(fileData: string) {
		if (fileData == null)
			return { success: false, message: "Invalid data" };
		let restoreResult = SettingsOperation.restoreBackupFromFile(fileData);
		if (!restoreResult.success) {
			return restoreResult;
		}
		let restoredConfig = restoreResult.config;
		Settings.current = restoredConfig;

		// save synced if needed
		SettingsOperation.saveAllSync();

		// update proxy rules/config
		proxyEngineLib.updateBrowsersProxyConfig();

		Settings.updateActiveSettings();

		return { success: true, message: api.i18n.getMessage("settingsRestoreSettingsSuccess") }
	}

	private static restoreBackupFromFile(fileData: string): {
		success: boolean,
		message?: string,
		config?: SettingsConfig
	} {
		let currentSettings = Settings.current;
		let backupConfig: SettingsConfig;
		try {
			try {
				backupConfig = JSON.parse(fileData);
			} catch (error) {
				Debug.error('Backup data is invalid or corrupted', error, fileData);
				return { success: false, message: api.i18n.getMessage("settingsRestoreSettingsFailedInvalid") };
			}

			if (!backupConfig.version) {
				Debug.error('Backup data is missing `Version` field', fileData);
				return { success: false, message: api.i18n.getMessage("settingsRestoreSettingsFailedInvalid") };
			}
			let settingsCopy = new SettingsConfig();
			settingsCopy.CopyFrom(currentSettings);

			// Copy backup details over and make sure the default values are set if they are not set
			// or are overwritten with null values
			// IMPORTANT: the prototype of `settingsCopy` is lost now because `backupConfig` is coming from JSON
			Object.assign(settingsCopy, backupConfig);

			Settings.setDefaultSettings(settingsCopy); // note: this method resets the version number

			// migrate from old versions
			settingsCopy.version = backupConfig.version;// resetting version to do a proper migration
			Settings.migrateFromOldVersions(settingsCopy);

			// resetting `settingsCopy` prototype
			let settingsCopy_PrototypeReset = new SettingsConfig();
			settingsCopy_PrototypeReset.CopyFrom(settingsCopy);
			// reset
			settingsCopy = settingsCopy_PrototypeReset;

			// -----------
			// The following codes is verifying the integrity of data from backup

			if (backupConfig.options) {
				settingsCopy.options.CopyFrom(backupConfig.options);
			}

			if (backupConfig.proxyServers &&
				Array.isArray(backupConfig.proxyServers) &&
				backupConfig.proxyServers.length) {

				let newProxyServers: ProxyServer[] = [];
				for (const backupProxy of backupConfig.proxyServers) {
					let newProxy = new ProxyServer();
					newProxy.CopyFrom(backupProxy);

					if (newProxy.isValid())
						newProxyServers.push(newProxy);
				}
				settingsCopy.proxyServers = newProxyServers;
			}

			if (backupConfig.proxyServerSubscriptions &&
				Array.isArray(backupConfig.proxyServerSubscriptions) &&
				backupConfig.proxyServerSubscriptions.length) {

				let newSubs: ProxyServerSubscription[] = [];
				for (let backupSub of backupConfig.proxyServerSubscriptions) {

					let newSubscription = new ProxyServerSubscription();
					newSubscription.CopyFrom(backupSub);

					newSubs.push(newSubscription);
				}

				settingsCopy.proxyServerSubscriptions = newSubs;
			}

			if (backupConfig.proxyProfiles &&
				Array.isArray(backupConfig.proxyProfiles) &&
				backupConfig.proxyProfiles.length) {

				let newProxyProfiles: SmartProfile[] = [];

				for (let backProxyProfile of backupConfig.proxyProfiles) {
					let newProfile = new SmartProfile();
					ProfileOperations.copySmartProfile(backProxyProfile, newProfile, false);

					ProfileOperations.resetProfileTypeConfig(newProfile);

					if (newProfile.profileTypeConfig.editable &&
						typeof (backProxyProfile['profileTypeConfig']['builtin']) === 'boolean')
						// `builtin` value needs a reset as the default values is not correct for user created profiles
						newProfile.profileTypeConfig.builtin = backProxyProfile.profileTypeConfig.builtin;

					newProxyProfiles.push(newProfile);
				}

				settingsCopy.proxyProfiles = newProxyProfiles;
			}

			if (backupConfig.activeProfileId && settingsCopy.proxyProfiles) {
				let activeProfile = settingsCopy.proxyProfiles.find(v => v.profileId == backupConfig.activeProfileId);
				if (activeProfile) {
					// yes it is valid
					settingsCopy.activeProfileId = activeProfile.profileId;
				}
			}

			if (backupConfig.defaultProxyServerId) {
				let proxyServerSub = SettingsOperation.findProxyServerByIdFromList(
					backupConfig.defaultProxyServerId,
					settingsCopy.proxyServers,
					settingsCopy.proxyServerSubscriptions
				);
				if (proxyServerSub) {
					// yes it is valid
					settingsCopy.defaultProxyServerId = proxyServerSub.id;
				}
			}

			settingsCopy.version = currentSettings.version;
			PolyFill.getExtensionVersion((version: string) => {
				settingsCopy.version = version;
			});
			Settings.ensureIntegrityOfSettings(settingsCopy);

			return { success: true, config: settingsCopy };

		} catch (e) {
			Debug.error('Backup restore failed', e, fileData);
			return { success: false, message: api.i18n.getMessage("settingsRestoreSettingsFailed") };
		}
	}

	public static factoryReset() {
		let newConfig = new SettingsConfig();
		Settings.setDefaultSettings(newConfig);

		Settings.current = newConfig;

		// save synced if needed
		SettingsOperation.saveAllSync();

		// update proxy rules/config
		proxyEngineLib.updateBrowsersProxyConfig();

		Settings.updateActiveSettings();
	}

	public static restoreBackup_OLD(fileData: string) {
		if (fileData == null)
			return { success: false, message: "Invalid data" };

		function restoreServers(backupServers: any[]) {
			let upcomingServers: ProxyServer[] = [];
			for (let backServer of backupServers) {

				let newServer = new ProxyServer();
				newServer.CopyFrom(backServer);

				let validateResult = Settings.validateProxyServer(newServer, false);
				if (!validateResult.success) {
					// if validation failed

					if (validateResult.exist) {
						continue;
					}
					// not exist, then failed
					return validateResult;
				}

				// -----------
				upcomingServers.push(newServer);
			}

			return { success: true, result: upcomingServers };
		}
		function restoreServerSubscriptions(backupServerSubscriptions: any[]) {
			let upcomingSubscriptions: ProxyServerSubscription[] = [];
			for (let subscription of backupServerSubscriptions) {

				let newSubscription = new ProxyServerSubscription();
				newSubscription.CopyFrom(subscription);

				upcomingSubscriptions.push(newSubscription);
			}

			return { success: true, result: upcomingSubscriptions };
		}

		function restoreProxyProfiles(backupProfiles: any[]) {
			let upcomingProxyProfiles: SmartProfile[] = [];
			for (let backProxyProfile of backupProfiles) {

				let newProfile = new SmartProfile();
				ProfileOperations.copySmartProfile(backProxyProfile, newProfile, false);

				for (const newRule of newProfile.proxyRules) {
					let validateResult = ProxyRules.validateRule(newRule);
					if (!validateResult.success) {
						// if validation failed
						// not exist, then failed
						return validateResult;
					}
				}

				// -----------
				upcomingProxyProfiles.push(newProfile);
			}

			return { success: true, result: upcomingProxyProfiles };
		}

		function restoreDefaultProxyServer(defaultProxyServerId: any) {

			let proxy = SettingsOperation.findProxyServerById(defaultProxyServerId);
			if (proxy == null) {
				return { success: false, result: api.i18n.getMessage("settingsRestoreSettingsFailedInvalidDefaultProxyServer") };
			}

			return { success: true, result: defaultProxyServerId };
		}

		function restoreActiveProfileId(backupActiveProfileId: any) {

			if (backupActiveProfileId == null ||
				backupActiveProfileId <= 0) {
				return { success: false, message: api.i18n.getMessage("settingsRestoreSettingsFailedInvalidActiveProfile") };
			}
			return { success: true, result: backupActiveProfileId };
		}

		function restoreOptions(backupOptions: any) {
			let newOptions = new GeneralOptions();
			newOptions.CopyFrom(backupOptions);

			return { success: true, result: newOptions };
		}

		try {
			let backupData = JSON.parse(fileData);
			let backupOptions: GeneralOptions;
			let backupServers: ProxyServer[];
			let backupServerSubscriptions: ProxyServerSubscription[];
			let backupProxyProfiles: SmartProfile[];
			let backupDefaultProxyServerId: string;
			let backupActiveProfileId: string;

			// -----------------------------------
			if (backupData["options"] != null &&
				typeof (backupData.options) == "object") {

				let restoreOptionsResult = restoreOptions(backupData.options);

				if (!restoreOptionsResult.success)
					return restoreOptionsResult;

				backupOptions = restoreOptionsResult.result;
			}

			// -----------------------------------
			if (backupData["proxyServers"] != null &&
				Array.isArray(backupData.proxyServers)) {

				let restoreServersResult = restoreServers(backupData.proxyServers);

				if (!restoreServersResult.success)
					return restoreServersResult;

				backupServers = restoreServersResult.result;
			}

			// -----------------------------------
			if (backupData["proxyServerSubscriptions"] != null &&
				Array.isArray(backupData.proxyServerSubscriptions)) {

				let restoreServerSubscriptionsResult = restoreServerSubscriptions(backupData.proxyServerSubscriptions);

				if (!restoreServerSubscriptionsResult.success)
					return restoreServerSubscriptionsResult;

				backupServerSubscriptions = restoreServerSubscriptionsResult.result;
			}

			// -----------------------------------
			if (backupData["proxyProfiles"] != null &&
				Array.isArray(backupData.proxyProfiles)) {

				let restoreRulesResult = restoreProxyProfiles(backupData.proxyProfiles);

				if (!restoreRulesResult.success)
					return restoreRulesResult;

				backupProxyProfiles = restoreRulesResult.result;
			}

			// -----------------------------------
			if (backupData["defaultProxyServerId"] != null &&
				typeof (backupData.defaultProxyServerId) == "string") {

				let restoreActiveServerResult = restoreDefaultProxyServer(backupData.defaultProxyServerId);

				if (!restoreActiveServerResult.success)
					return restoreActiveServerResult;

				backupDefaultProxyServerId = restoreActiveServerResult.result;
			}

			// -----------------------------------
			if (backupData["activeProfileId"] != null &&
				typeof (backupData.activeProfileId) == "string") {

				let restoreActiveProfileIdResult = restoreActiveProfileId(backupData.activeProfileId);

				if (!restoreActiveProfileIdResult.success)
					return restoreActiveProfileIdResult;

				backupActiveProfileId = restoreActiveProfileIdResult.result;
			}

			// everything is fine so far
			// so start restoring
			if (backupOptions != null) {
				Settings.current.options = backupOptions;

				SettingsOperation.saveOptions();
			}

			if (backupServers != null) {
				Settings.current.proxyServers = backupServers;

				SettingsOperation.saveProxyServers();
			}

			if (backupServerSubscriptions != null) {

				Settings.current.proxyServerSubscriptions = backupServerSubscriptions;

				SettingsOperation.saveProxyServerSubscriptions();
				// update the timers
				subscriptionUpdaterLib.setServerSubscriptionsRefreshTimers();
			}

			if (backupProxyProfiles != null) {

				Settings.current.proxyProfiles = backupProxyProfiles;

				SettingsOperation.saveSmartProfiles();
				proxyEngineLib.notifyProxyRulesChanged();
				// update the timers
				subscriptionUpdaterLib.setRulesSubscriptionsRefreshTimers();
			}

			if (backupDefaultProxyServerId != null) {

				Settings.current.defaultProxyServerId = backupDefaultProxyServerId;

				SettingsOperation.saveDefaultProxyServer();
			}

			if (backupActiveProfileId != null) {

				Settings.current.activeProfileId = backupActiveProfileId;

				SettingsOperation.saveActiveProfile();
			}

			// save synced if needed
			SettingsOperation.saveAllSync();

			// update proxy rules/config
			proxyEngineLib.updateBrowsersProxyConfig();

			Settings.updateActiveSettings();

			return { success: true, message: api.i18n.getMessage("settingsRestoreSettingsSuccess") }


		} catch (e) {
			Debug.error('Backup restore failed', e, fileData);
			return { success: false, message: api.i18n.getMessage("settingsRestoreSettingsFailed") };
		}
	}
}

let me = SettingsOperation;