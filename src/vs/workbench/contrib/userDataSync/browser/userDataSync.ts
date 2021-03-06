/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the Source EULA. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Action } from 'vs/base/common/actions';
import { toErrorMessage } from 'vs/base/common/errorMessage';
import { canceled, isPromiseCanceledError } from 'vs/base/common/errors';
import { Event } from 'vs/base/common/event';
import { Disposable, DisposableStore, dispose, MutableDisposable, toDisposable, IDisposable } from 'vs/base/common/lifecycle';
import { isWeb } from 'vs/base/common/platform';
import { isEqual, basename } from 'vs/base/common/resources';
import { URI } from 'vs/base/common/uri';
import type { ICodeEditor } from 'vs/editor/browser/editorBrowser';
import { registerEditorContribution, ServicesAccessor } from 'vs/editor/browser/editorExtensions';
import type { IEditorContribution } from 'vs/editor/common/editorCommon';
import type { ITextModel } from 'vs/editor/common/model';
import { AuthenticationSession, AuthenticationSessionsChangeEvent } from 'vs/editor/common/modes';
import { IModelService } from 'vs/editor/common/services/modelService';
import { IModeService } from 'vs/editor/common/services/modeService';
import { ITextModelContentProvider, ITextModelService } from 'vs/editor/common/services/resolverService';
import { localize } from 'vs/nls';
import { MenuId, MenuRegistry, registerAction2, Action2 } from 'vs/platform/actions/common/actions';
import { CommandsRegistry, ICommandService } from 'vs/platform/commands/common/commands';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { ContextKeyExpr, IContextKey, IContextKeyService, RawContextKey } from 'vs/platform/contextkey/common/contextkey';
import { IDialogService } from 'vs/platform/dialogs/common/dialogs';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { INotificationService, Severity } from 'vs/platform/notification/common/notification';
import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from 'vs/platform/quickinput/common/quickInput';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import {
	CONTEXT_SYNC_STATE, getUserDataSyncStore, ISyncConfiguration, IUserDataAutoSyncService, IUserDataSyncService, IUserDataSyncStore, registerConfiguration,
	SyncResource, SyncStatus, UserDataSyncError, UserDataSyncErrorCode, USER_DATA_SYNC_SCHEME, IUserDataSyncEnablementService, CONTEXT_SYNC_ENABLEMENT,
	SyncResourceConflicts, Conflict, getSyncResourceFromLocalPreview
} from 'vs/platform/userDataSync/common/userDataSync';
import { FloatingClickWidget } from 'vs/workbench/browser/parts/editor/editorWidgets';
import { GLOBAL_ACTIVITY_ID } from 'vs/workbench/common/activity';
import { IWorkbenchContribution } from 'vs/workbench/common/contributions';
import { IEditorInput, toResource, SideBySideEditor } from 'vs/workbench/common/editor';
import { DiffEditorInput } from 'vs/workbench/common/editor/diffEditorInput';
import * as Constants from 'vs/workbench/contrib/logs/common/logConstants';
import { IOutputService } from 'vs/workbench/contrib/output/common/output';
import { UserDataSyncTrigger } from 'vs/workbench/contrib/userDataSync/browser/userDataSyncTrigger';
import { IActivityService, IBadge, NumberBadge } from 'vs/workbench/services/activity/common/activity';
import { IAuthenticationService } from 'vs/workbench/services/authentication/browser/authenticationService';
import { IEditorService } from 'vs/workbench/services/editor/common/editorService';
import { IWorkbenchEnvironmentService } from 'vs/workbench/services/environment/common/environmentService';
import { IPreferencesService } from 'vs/workbench/services/preferences/common/preferences';
import { IAuthenticationTokenService } from 'vs/platform/authentication/common/authentication';
import { fromNow } from 'vs/base/common/date';
import { IProductService } from 'vs/platform/product/common/productService';
import { IStorageService, StorageScope } from 'vs/platform/storage/common/storage';
import { IOpenerService } from 'vs/platform/opener/common/opener';
import { distinct } from 'vs/base/common/arrays';

const enum AuthStatus {
	Initializing = 'Initializing',
	SignedIn = 'SignedIn',
	SignedOut = 'SignedOut',
	Unavailable = 'Unavailable'
}
const CONTEXT_AUTH_TOKEN_STATE = new RawContextKey<string>('authTokenStatus', AuthStatus.Initializing);
const CONTEXT_CONFLICTS_SOURCES = new RawContextKey<string>('conflictsSources', '');

const USER_DATA_SYNC_ACCOUNT_PREFERENCE_KEY = 'userDataSyncAccountPreference';

type ConfigureSyncQuickPickItem = { id: SyncResource, label: string, description?: string };

function getSyncAreaLabel(source: SyncResource): string {
	switch (source) {
		case SyncResource.Settings: return localize('settings', "Settings");
		case SyncResource.Keybindings: return localize('keybindings', "Keyboard Shortcuts");
		case SyncResource.Snippets: return localize('snippets', "User Snippets");
		case SyncResource.Extensions: return localize('extensions', "Extensions");
		case SyncResource.GlobalState: return localize('ui state label', "UI State");
	}
}

type SyncConflictsClassification = {
	source: { classification: 'SystemMetaData', purpose: 'FeatureInsight', isMeasurement: true };
	action?: { classification: 'SystemMetaData', purpose: 'FeatureInsight', isMeasurement: true };
};

type FirstTimeSyncClassification = {
	action: { classification: 'SystemMetaData', purpose: 'FeatureInsight', isMeasurement: true };
};

const getActivityTitle = (label: string, userDataSyncService: IUserDataSyncService): string => {
	if (userDataSyncService.status === SyncStatus.Syncing) {
		return localize('sync is on with syncing', "{0} (syncing)", label);
	}
	if (userDataSyncService.lastSyncTime) {
		return localize('sync is on with time', "{0} (synced {1})", label, fromNow(userDataSyncService.lastSyncTime, true));
	}
	return label;
};
const getIdentityTitle = (label: string, authenticationProviderId: string, account: AuthenticationSession | undefined, authenticationService: IAuthenticationService): string => {
	return account ? `${label} (${authenticationService.getDisplayName(authenticationProviderId)}:${account.accountName})` : label;
};
const turnOnSyncCommand = { id: 'workbench.userData.actions.syncStart', title: localize('turn on sync with category', "Preferences Sync: Turn on...") };
const signInCommand = { id: 'workbench.userData.actions.signin', title: localize('sign in', "Preferences Sync: Sign in to sync") };
const stopSyncCommand = { id: 'workbench.userData.actions.stopSync', title(authenticationProviderId: string, account: AuthenticationSession | undefined, authenticationService: IAuthenticationService) { return getIdentityTitle(localize('stop sync', "Preferences Sync: Turn off"), authenticationProviderId, account, authenticationService); } };
const resolveSettingsConflictsCommand = { id: 'workbench.userData.actions.resolveSettingsConflicts', title: localize('showConflicts', "Preferences Sync: Show Settings Conflicts") };
const resolveKeybindingsConflictsCommand = { id: 'workbench.userData.actions.resolveKeybindingsConflicts', title: localize('showKeybindingsConflicts', "Preferences Sync: Show Keybindings Conflicts") };
const resolveSnippetsConflictsCommand = { id: 'workbench.userData.actions.resolveSnippetsConflicts', title: localize('showSnippetsConflicts', "Preferences Sync: Show User Snippets Conflicts") };
const configureSyncCommand = { id: 'workbench.userData.actions.configureSync', title: localize('configure sync', "Preferences Sync: Configure...") };
const showSyncActivityCommand = {
	id: 'workbench.userData.actions.showSyncActivity', title(userDataSyncService: IUserDataSyncService): string {
		return getActivityTitle(localize('show sync log', "Preferences Sync: Show Log"), userDataSyncService);
	}
};
const showSyncSettingsCommand = { id: 'workbench.userData.actions.syncSettings', title: localize('sync settings', "Preferences Sync: Show Settings"), };

export class UserDataSyncWorkbenchContribution extends Disposable implements IWorkbenchContribution {

	private readonly userDataSyncStore: IUserDataSyncStore | undefined;
	private readonly syncEnablementContext: IContextKey<boolean>;
	private readonly syncStatusContext: IContextKey<string>;
	private readonly authenticationState: IContextKey<string>;
	private readonly conflictsSources: IContextKey<string>;

	private readonly badgeDisposable = this._register(new MutableDisposable());
	private readonly signInNotificationDisposable = this._register(new MutableDisposable());
	private _activeAccount: AuthenticationSession | undefined;

	constructor(
		@IUserDataSyncEnablementService private readonly userDataSyncEnablementService: IUserDataSyncEnablementService,
		@IUserDataSyncService private readonly userDataSyncService: IUserDataSyncService,
		@IAuthenticationService private readonly authenticationService: IAuthenticationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IActivityService private readonly activityService: IActivityService,
		@INotificationService private readonly notificationService: INotificationService,
		@IConfigurationService configurationService: IConfigurationService,
		@IEditorService private readonly editorService: IEditorService,
		@IWorkbenchEnvironmentService private readonly workbenchEnvironmentService: IWorkbenchEnvironmentService,
		@IDialogService private readonly dialogService: IDialogService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOutputService private readonly outputService: IOutputService,
		@IAuthenticationTokenService private readonly authTokenService: IAuthenticationTokenService,
		@IUserDataAutoSyncService userDataAutoSyncService: IUserDataAutoSyncService,
		@ITextModelService private readonly textModelResolverService: ITextModelService,
		@IPreferencesService private readonly preferencesService: IPreferencesService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@IProductService private readonly productService: IProductService,
		@IStorageService private readonly storageService: IStorageService,
		@IOpenerService private readonly openerService: IOpenerService,
	) {
		super();
		this.userDataSyncStore = getUserDataSyncStore(productService, configurationService);
		this.syncEnablementContext = CONTEXT_SYNC_ENABLEMENT.bindTo(contextKeyService);
		this.syncStatusContext = CONTEXT_SYNC_STATE.bindTo(contextKeyService);
		this.authenticationState = CONTEXT_AUTH_TOKEN_STATE.bindTo(contextKeyService);
		this.conflictsSources = CONTEXT_CONFLICTS_SOURCES.bindTo(contextKeyService);
		if (this.userDataSyncStore) {
			registerConfiguration();
			this.onDidChangeSyncStatus(this.userDataSyncService.status);
			this.onDidChangeConflicts(this.userDataSyncService.conflicts);
			this.onDidChangeEnablement(this.userDataSyncEnablementService.isEnabled());
			this._register(Event.debounce(userDataSyncService.onDidChangeStatus, () => undefined, 500)(() => this.onDidChangeSyncStatus(this.userDataSyncService.status)));
			this._register(userDataSyncService.onDidChangeConflicts(() => this.onDidChangeConflicts(this.userDataSyncService.conflicts)));
			this._register(userDataSyncService.onSyncErrors(errors => this.onSyncErrors(errors)));
			this._register(this.authTokenService.onTokenFailed(_ => this.onTokenFailed()));
			this._register(this.userDataSyncEnablementService.onDidChangeEnablement(enabled => this.onDidChangeEnablement(enabled)));
			this._register(this.authenticationService.onDidRegisterAuthenticationProvider(e => this.onDidRegisterAuthenticationProvider(e)));
			this._register(this.authenticationService.onDidUnregisterAuthenticationProvider(e => this.onDidUnregisterAuthenticationProvider(e)));
			this._register(this.authenticationService.onDidChangeSessions(e => this.onDidChangeSessions(e)));
			this._register(userDataAutoSyncService.onError(error => this.onAutoSyncError(error)));
			this.registerActions();
			this.initializeActiveAccount().then(_ => {
				if (!isWeb) {
					this._register(instantiationService.createInstance(UserDataSyncTrigger).onDidTriggerSync(source => userDataAutoSyncService.triggerAutoSync([source])));
				}
			});

			textModelResolverService.registerTextModelContentProvider(USER_DATA_SYNC_SCHEME, instantiationService.createInstance(UserDataRemoteContentProvider));
			registerEditorContribution(AcceptChangesContribution.ID, AcceptChangesContribution);
		}
	}

	private async initializeActiveAccount(): Promise<void> {
		const sessions = await this.authenticationService.getSessions(this.userDataSyncStore!.authenticationProviderId);
		// Auth provider has not yet been registered
		if (!sessions) {
			return;
		}

		if (sessions.length === 0) {
			await this.setActiveAccount(undefined);
			return;
		}

		if (sessions.length === 1) {
			this.logAuthenticatedEvent(sessions[0]);
			await this.setActiveAccount(sessions[0]);
			return;
		}

		const accountPreference = this.storageService.get(USER_DATA_SYNC_ACCOUNT_PREFERENCE_KEY, StorageScope.GLOBAL);
		if (accountPreference) {
			const matchingSession = sessions.find(session => session.id === accountPreference);
			if (matchingSession) {
				this.setActiveAccount(matchingSession);
				return;
			}
		}

		await this.showSwitchAccountPicker(sessions);
	}

	private logAuthenticatedEvent(session: AuthenticationSession): void {
		type UserAuthenticatedClassification = {
			id: { classification: 'EndUserPseudonymizedInformation', purpose: 'BusinessInsight' };
		};

		type UserAuthenticatedEvent = {
			id: string;
		};

		const id = session.id.split('/')[1];
		this.telemetryService.publicLog2<UserAuthenticatedEvent, UserAuthenticatedClassification>('user.authenticated', { id });
	}

	get activeAccount(): AuthenticationSession | undefined {
		return this._activeAccount;
	}

	async setActiveAccount(account: AuthenticationSession | undefined) {
		this._activeAccount = account;

		if (account) {
			try {
				const token = await account.getAccessToken();
				this.authTokenService.setToken(token);
				this.authenticationState.set(AuthStatus.SignedIn);
			} catch (e) {
				this.authTokenService.setToken(undefined);
				this.authenticationState.set(AuthStatus.Unavailable);
			}
		} else {
			this.authTokenService.setToken(undefined);
			this.authenticationState.set(AuthStatus.SignedOut);
		}

		this.updateBadge();
	}

	private async showSwitchAccountPicker(sessions: readonly AuthenticationSession[]): Promise<void> {
		return new Promise((resolve, _) => {
			const quickPick = this.quickInputService.createQuickPick<{ label: string, session: AuthenticationSession }>();
			quickPick.title = localize('chooseAccountTitle', "Preferences Sync: Choose Account");
			quickPick.placeholder = localize('chooseAccount', "Choose an account you would like to use for settings sync");
			const dedupedSessions = distinct(sessions, (session) => session.accountName);
			quickPick.items = dedupedSessions.map(session => {
				return {
					label: session.accountName,
					session: session
				};
			});

			quickPick.onDidHide(() => {
				quickPick.dispose();
				resolve();
			});

			quickPick.onDidAccept(() => {
				const selected = quickPick.selectedItems[0];
				this.setActiveAccount(selected.session);
				this.storageService.store(USER_DATA_SYNC_ACCOUNT_PREFERENCE_KEY, selected.session.id, StorageScope.GLOBAL);
				quickPick.dispose();
				resolve();
			});

			quickPick.show();
		});
	}

	private async onDidChangeSessions(e: { providerId: string, event: AuthenticationSessionsChangeEvent }): Promise<void> {
		const { providerId, event } = e;
		if (providerId === this.userDataSyncStore!.authenticationProviderId) {
			if (this.activeAccount) {
				if (event.removed.length) {
					const activeWasRemoved = !!event.removed.find(removed => removed === this.activeAccount!.id);

					// If the current account was removed, check if another account can be used, otherwise offer to turn off sync
					if (activeWasRemoved) {
						const accounts = (await this.authenticationService.getSessions(this.userDataSyncStore!.authenticationProviderId) || []);
						if (accounts.length) {
							// Show switch dialog here
							await this.showSwitchAccountPicker(accounts);
						} else {
							await this.turnOff();
							this.setActiveAccount(undefined);
							return;
						}

					}
				}

				if (event.added.length) {
					// Offer to switch accounts
					const accounts = (await this.authenticationService.getSessions(this.userDataSyncStore!.authenticationProviderId) || []);
					await this.showSwitchAccountPicker(accounts);
					return;
				}

				if (event.changed.length) {
					const activeWasChanged = !!event.changed.find(changed => changed === this.activeAccount!.id);
					if (activeWasChanged) {
						// Try to update existing account, case where access token has been refreshed
						const accounts = (await this.authenticationService.getSessions(this.userDataSyncStore!.authenticationProviderId) || []);
						const matchingAccount = accounts.filter(a => a.id === this.activeAccount?.id)[0];
						this.setActiveAccount(matchingAccount);
					}
				}
			} else {
				await this.initializeActiveAccount();

				// If logged in for the first time from accounts menu, prompt if sync should be turned on
				if (this.activeAccount) {
					this.turnOn(true);
				}
			}
		}
	}

	private async onTokenFailed(): Promise<void> {
		if (this.activeAccount) {
			const accounts = (await this.authenticationService.getSessions(this.userDataSyncStore!.authenticationProviderId) || []);
			const matchingAccount = accounts.filter(a => a.id === this.activeAccount?.id)[0];
			this.setActiveAccount(matchingAccount);
		} else {
			this.setActiveAccount(undefined);
		}
	}

	private async onDidRegisterAuthenticationProvider(providerId: string) {
		if (providerId === this.userDataSyncStore!.authenticationProviderId) {
			await this.initializeActiveAccount();
		}
	}

	private onDidUnregisterAuthenticationProvider(providerId: string) {
		if (providerId === this.userDataSyncStore!.authenticationProviderId) {
			this.setActiveAccount(undefined);
			this.authenticationState.reset();
		}
	}

	private onDidChangeSyncStatus(status: SyncStatus) {
		this.syncStatusContext.set(status);
		this.updateBadge();
	}

	private readonly conflictsDisposables = new Map<SyncResource, IDisposable>();
	private onDidChangeConflicts(conflicts: SyncResourceConflicts[]) {
		this.updateBadge();
		if (conflicts.length) {
			const conflictsSources: SyncResource[] = conflicts.map(conflict => conflict.syncResource);
			this.conflictsSources.set(conflictsSources.join(','));
			if (conflictsSources.indexOf(SyncResource.Snippets) !== -1) {
				this.registerShowSnippetsConflictsAction();
			}

			// Clear and dispose conflicts those were cleared
			this.conflictsDisposables.forEach((disposable, conflictsSource) => {
				if (conflictsSources.indexOf(conflictsSource) === -1) {
					disposable.dispose();
					this.conflictsDisposables.delete(conflictsSource);
				}
			});

			for (const { syncResource, conflicts } of this.userDataSyncService.conflicts) {
				const conflictsEditorInputs = this.getConflictsEditorInputs(syncResource);

				// close stale conflicts editor previews
				if (conflictsEditorInputs.length) {
					conflictsEditorInputs.forEach(input => {
						if (!conflicts.some(({ local }) => isEqual(local, input.master.resource))) {
							input.dispose();
						}
					});
				}

				// Show conflicts notification if not shown before
				else if (!this.conflictsDisposables.has(syncResource)) {
					const conflictsArea = getSyncAreaLabel(syncResource);
					const handle = this.notificationService.prompt(Severity.Warning, localize('conflicts detected', "Unable to sync due to conflicts in {0}. Please resolve them to continue.", conflictsArea.toLowerCase()),
						[
							{
								label: localize('accept remote', "Accept Remote"),
								run: () => {
									this.telemetryService.publicLog2<{ source: string, action: string }, SyncConflictsClassification>('sync/handleConflicts', { source: syncResource, action: 'acceptRemote' });
									this.acceptRemote(syncResource, conflicts);
								}
							},
							{
								label: localize('accept local', "Accept Local"),
								run: () => {
									this.telemetryService.publicLog2<{ source: string, action: string }, SyncConflictsClassification>('sync/handleConflicts', { source: syncResource, action: 'acceptLocal' });
									this.acceptLocal(syncResource, conflicts);
								}
							},
							{
								label: localize('show conflicts', "Show Conflicts"),
								run: () => {
									this.telemetryService.publicLog2<{ source: string, action?: string }, SyncConflictsClassification>('sync/showConflicts', { source: syncResource });
									this.handleConflicts({ syncResource, conflicts });
								}
							}
						],
						{
							sticky: true
						}
					);
					this.conflictsDisposables.set(syncResource, toDisposable(() => {

						// close the conflicts warning notification
						handle.close();

						// close opened conflicts editor previews
						const conflictsEditorInputs = this.getConflictsEditorInputs(syncResource);
						if (conflictsEditorInputs.length) {
							conflictsEditorInputs.forEach(input => input.dispose());
						}

						this.conflictsDisposables.delete(syncResource);
					}));
				}
			}
		} else {
			this.conflictsSources.reset();
			this.getAllConflictsEditorInputs().forEach(input => input.dispose());
			this.conflictsDisposables.forEach(disposable => disposable.dispose());
			this.conflictsDisposables.clear();
		}
	}

	private async acceptRemote(syncResource: SyncResource, conflicts: Conflict[]) {
		try {
			for (const conflict of conflicts) {
				const modelRef = await this.textModelResolverService.createModelReference(conflict.remote);
				await this.userDataSyncService.acceptConflict(conflict.remote, modelRef.object.textEditorModel.getValue());
				modelRef.dispose();
			}
		} catch (e) {
			this.notificationService.error(e);
		}
	}

	private async acceptLocal(syncResource: SyncResource, conflicts: Conflict[]): Promise<void> {
		try {
			for (const conflict of conflicts) {
				const modelRef = await this.textModelResolverService.createModelReference(conflict.local);
				await this.userDataSyncService.acceptConflict(conflict.local, modelRef.object.textEditorModel.getValue());
				modelRef.dispose();
			}
		} catch (e) {
			this.notificationService.error(e);
		}
	}

	private onDidChangeEnablement(enabled: boolean) {
		this.syncEnablementContext.set(enabled);
		this.updateBadge();
		if (enabled) {
			if (this.authenticationState.get() === AuthStatus.SignedOut) {
				const displayName = this.authenticationService.getDisplayName(this.userDataSyncStore!.authenticationProviderId);
				const handle = this.notificationService.prompt(Severity.Info, localize('sign in message', "Please sign in with your {0} account to continue sync", displayName),
					[
						{
							label: localize('Sign in', "Sign in"),
							run: () => this.signIn()
						}
					]);
				this.signInNotificationDisposable.value = toDisposable(() => handle.close());
				handle.onDidClose(() => this.signInNotificationDisposable.clear());
			}
		} else {
			this.signInNotificationDisposable.clear();
		}
	}

	private onAutoSyncError(error: UserDataSyncError): void {
		switch (error.code) {
			case UserDataSyncErrorCode.TurnedOff:
			case UserDataSyncErrorCode.SessionExpired:
				this.notificationService.notify({
					severity: Severity.Info,
					message: localize('turned off', "Sync was turned off from another device."),
					actions: {
						primary: [new Action('turn on sync', localize('turn on sync', "Turn on Sync"), undefined, true, () => this.turnOn())]
					}
				});
				return;
			case UserDataSyncErrorCode.TooLarge:
				if (error.resource === SyncResource.Keybindings || error.resource === SyncResource.Settings) {
					this.disableSync(error.resource);
					const sourceArea = getSyncAreaLabel(error.resource);
					this.notificationService.notify({
						severity: Severity.Error,
						message: localize('too large', "Disabled syncing {0} because size of the {1} file to sync is larger than {2}. Please open the file and reduce the size and enable sync", sourceArea.toLowerCase(), sourceArea.toLowerCase(), '100kb'),
						actions: {
							primary: [new Action('open sync file', localize('open file', "Open {0} File", sourceArea), undefined, true,
								() => error.resource === SyncResource.Settings ? this.preferencesService.openGlobalSettings(true) : this.preferencesService.openGlobalKeybindingSettings(true))]
						}
					});
				}
				return;
			case UserDataSyncErrorCode.Incompatible:
				this.disableSync();
				this.notificationService.notify({
					severity: Severity.Error,
					message: localize('error incompatible', "Turned off sync because local data is incompatible with the data in the cloud. Please update {0} and turn on sync to continue syncing.", this.productService.nameLong),
				});
				return;
		}
	}

	private readonly invalidContentErrorDisposables = new Map<SyncResource, IDisposable>();
	private onSyncErrors(errors: [SyncResource, UserDataSyncError][]): void {
		if (errors.length) {
			for (const [source, error] of errors) {
				switch (error.code) {
					case UserDataSyncErrorCode.LocalInvalidContent:
						this.handleInvalidContentError(source);
						break;
					default:
						const disposable = this.invalidContentErrorDisposables.get(source);
						if (disposable) {
							disposable.dispose();
							this.invalidContentErrorDisposables.delete(source);
						}
				}
			}
		} else {
			this.invalidContentErrorDisposables.forEach(disposable => disposable.dispose());
			this.invalidContentErrorDisposables.clear();
		}
	}

	private handleInvalidContentError(source: SyncResource): void {
		if (this.invalidContentErrorDisposables.has(source)) {
			return;
		}
		if (source !== SyncResource.Settings && source !== SyncResource.Keybindings) {
			return;
		}
		const resource = source === SyncResource.Settings ? this.workbenchEnvironmentService.settingsResource : this.workbenchEnvironmentService.keybindingsResource;
		if (isEqual(resource, toResource(this.editorService.activeEditor, { supportSideBySide: SideBySideEditor.MASTER }))) {
			// Do not show notification if the file in error is active
			return;
		}
		const errorArea = getSyncAreaLabel(source);
		const handle = this.notificationService.notify({
			severity: Severity.Error,
			message: localize('errorInvalidConfiguration', "Unable to sync {0} because there are some errors/warnings in the file. Please open the file to correct errors/warnings in it.", errorArea.toLowerCase()),
			actions: {
				primary: [new Action('open sync file', localize('open file', "Open {0} File", errorArea), undefined, true,
					() => source === SyncResource.Settings ? this.preferencesService.openGlobalSettings(true) : this.preferencesService.openGlobalKeybindingSettings(true))]
			}
		});
		this.invalidContentErrorDisposables.set(source, toDisposable(() => {
			// close the error warning notification
			handle.close();
			this.invalidContentErrorDisposables.delete(source);
		}));
	}

	private async updateBadge(): Promise<void> {
		this.badgeDisposable.clear();

		let badge: IBadge | undefined = undefined;
		let clazz: string | undefined;
		let priority: number | undefined = undefined;

		if (this.userDataSyncService.status !== SyncStatus.Uninitialized && this.userDataSyncEnablementService.isEnabled() && this.authenticationState.get() === AuthStatus.SignedOut) {
			badge = new NumberBadge(1, () => localize('sign in to sync', "Sign in to Sync"));
		} else if (this.userDataSyncService.conflicts.length) {
			badge = new NumberBadge(this.userDataSyncService.conflicts.reduce((result, syncResourceConflict) => { return result + syncResourceConflict.conflicts.length; }, 0), () => localize('has conflicts', "Preferences Sync: Conflicts Detected"));
		}

		if (badge) {
			this.badgeDisposable.value = this.activityService.showActivity(GLOBAL_ACTIVITY_ID, badge, clazz, priority);
		}
	}

	private async turnOn(skipAccountPick?: boolean): Promise<void> {
		if (!this.storageService.getBoolean('sync.donotAskPreviewConfirmation', StorageScope.GLOBAL, false)) {
			const result = await this.dialogService.show(
				Severity.Info,
				localize('sync preview message', "Synchronizing your preferences is a preview feature, please read the documentation before turning it on."),
				[
					localize('open doc', "Open Documentation"),
					localize('turn on sync', "Turn on Sync"),
					localize('cancel', "Cancel"),
				],
				{
					cancelId: 2
				}
			);
			switch (result.choice) {
				case 0: this.openerService.open(URI.parse('https://aka.ms/vscode-settings-sync-help')); return;
				case 2: return;
			}
		} else if (skipAccountPick) {
			const result = await this.dialogService.confirm({
				type: 'info',
				message: localize('turn on sync confirmation', "Do you want to turn on preferences sync?"),
				primaryButton: localize('turn on', "Turn On")
			});
			if (!result.confirmed) {
				return;
			}
		}

		return new Promise((c, e) => {
			const disposables: DisposableStore = new DisposableStore();
			const quickPick = this.quickInputService.createQuickPick<ConfigureSyncQuickPickItem>();
			disposables.add(quickPick);
			quickPick.title = localize('turn on title', "Preferences Sync: Turn On");
			quickPick.ok = false;
			quickPick.customButton = true;
			if (this.authenticationState.get() === AuthStatus.SignedIn) {
				quickPick.customLabel = localize('turn on', "Turn On");
			} else {
				const displayName = this.authenticationService.getDisplayName(this.userDataSyncStore!.authenticationProviderId);
				quickPick.description = localize('sign in and turn on sync detail', "Sign in with your {0} account to synchronize your data across devices.", displayName);
				quickPick.customLabel = localize('sign in and turn on sync', "Sign in & Turn on");
			}
			quickPick.placeholder = localize('configure sync placeholder', "Choose what to sync");
			quickPick.canSelectMany = true;
			quickPick.ignoreFocusOut = true;
			const items = this.getConfigureSyncQuickPickItems();
			quickPick.items = items;
			quickPick.selectedItems = items.filter(item => this.userDataSyncEnablementService.isResourceEnabled(item.id));
			disposables.add(Event.any(quickPick.onDidAccept, quickPick.onDidCustom)(async () => {
				if (quickPick.selectedItems.length) {
					this.updateConfiguration(items, quickPick.selectedItems);
					this.doTurnOn(skipAccountPick).then(c, e);
					quickPick.hide();
				}
			}));
			disposables.add(quickPick.onDidHide(() => disposables.dispose()));
			quickPick.show();
		});
	}

	private async doTurnOn(skipAccountPick?: boolean): Promise<void> {
		if (this.authenticationState.get() === AuthStatus.SignedIn && !skipAccountPick) {
			await new Promise((c, e) => {
				const disposables: DisposableStore = new DisposableStore();
				const displayName = this.authenticationService.getDisplayName(this.userDataSyncStore!.authenticationProviderId);
				const quickPick = this.quickInputService.createQuickPick<{ id: string, label: string, description?: string, detail?: string }>();
				disposables.add(quickPick);
				const chooseAnotherItemId = 'chooseAnother';
				quickPick.title = localize('pick account', "{0}: Pick an account", displayName);
				quickPick.ok = false;
				quickPick.placeholder = localize('choose account placeholder', "Pick an account for syncing");
				quickPick.ignoreFocusOut = true;
				quickPick.items = [{
					id: 'existing',
					label: localize('existing', "{0}", this.activeAccount!.accountName),
					detail: localize('signed in', "Signed in"),
				}, {
					id: chooseAnotherItemId,
					label: localize('choose another', "Use another account")
				}];
				disposables.add(quickPick.onDidAccept(async () => {
					if (quickPick.selectedItems.length) {
						if (quickPick.selectedItems[0].id === chooseAnotherItemId) {
							await this.authenticationService.logout(this.userDataSyncStore!.authenticationProviderId, this.activeAccount!.id);
							await this.setActiveAccount(undefined);
						}
						quickPick.hide();
						c();
					}
				}));
				disposables.add(quickPick.onDidHide(() => disposables.dispose()));
				quickPick.show();
			});
		}
		if (this.authenticationState.get() === AuthStatus.SignedOut) {
			await this.signIn();
		}
		await this.handleFirstTimeSync();
		this.userDataSyncEnablementService.setEnablement(true);
		this.notificationService.info(localize('sync turned on', "Sync will happen automatically from now on."));
		this.storageService.store('sync.donotAskPreviewConfirmation', true, StorageScope.GLOBAL);
	}

	private getConfigureSyncQuickPickItems(): ConfigureSyncQuickPickItem[] {
		return [{
			id: SyncResource.Settings,
			label: getSyncAreaLabel(SyncResource.Settings)
		}, {
			id: SyncResource.Keybindings,
			label: getSyncAreaLabel(SyncResource.Keybindings)
		}, {
			id: SyncResource.Snippets,
			label: getSyncAreaLabel(SyncResource.Snippets)
		}, {
			id: SyncResource.Extensions,
			label: getSyncAreaLabel(SyncResource.Extensions)
		}, {
			id: SyncResource.GlobalState,
			label: getSyncAreaLabel(SyncResource.GlobalState),
		}];
	}

	private updateConfiguration(items: ConfigureSyncQuickPickItem[], selectedItems: ReadonlyArray<ConfigureSyncQuickPickItem>): void {
		for (const item of items) {
			const wasEnabled = this.userDataSyncEnablementService.isResourceEnabled(item.id);
			const isEnabled = !!selectedItems.filter(selected => selected.id === item.id)[0];
			if (wasEnabled !== isEnabled) {
				this.userDataSyncEnablementService.setResourceEnablement(item.id!, isEnabled);
			}
		}
	}

	private async configureSyncOptions(): Promise<ISyncConfiguration> {
		return new Promise((c, e) => {
			const disposables: DisposableStore = new DisposableStore();
			const quickPick = this.quickInputService.createQuickPick<ConfigureSyncQuickPickItem>();
			disposables.add(quickPick);
			quickPick.title = localize('configure sync', "Preferences Sync: Configure...");
			quickPick.placeholder = localize('configure sync placeholder', "Choose what to sync");
			quickPick.canSelectMany = true;
			quickPick.ignoreFocusOut = true;
			quickPick.ok = true;
			const items = this.getConfigureSyncQuickPickItems();
			quickPick.items = items;
			quickPick.selectedItems = items.filter(item => this.userDataSyncEnablementService.isResourceEnabled(item.id));
			disposables.add(quickPick.onDidAccept(async () => {
				if (quickPick.selectedItems.length) {
					await this.updateConfiguration(items, quickPick.selectedItems);
					quickPick.hide();
				}
			}));
			disposables.add(quickPick.onDidHide(() => {
				disposables.dispose();
				c();
			}));
			quickPick.show();
		});
	}

	private async handleFirstTimeSync(): Promise<void> {
		const isFirstSyncWithMerge = await this.userDataSyncService.isFirstTimeSyncWithMerge();
		if (!isFirstSyncWithMerge) {
			return;
		}
		const result = await this.dialogService.show(
			Severity.Info,
			localize('firs time sync', "Sync"),
			[
				localize('merge', "Merge"),
				localize('cancel', "Cancel"),
				localize('replace', "Replace Local"),
			],
			{
				cancelId: 1,
				detail: localize('first time sync detail', "It looks like this is the first time sync is set up.\nWould you like to merge or replace with the data from the cloud?"),
			}
		);
		switch (result.choice) {
			case 0:
				this.telemetryService.publicLog2<{ action: string }, FirstTimeSyncClassification>('sync/firstTimeSync', { action: 'merge' });
				break;
			case 1:
				this.telemetryService.publicLog2<{ action: string }, FirstTimeSyncClassification>('sync/firstTimeSync', { action: 'cancelled' });
				throw canceled();
			case 2:
				this.telemetryService.publicLog2<{ action: string }, FirstTimeSyncClassification>('sync/firstTimeSync', { action: 'replace-local' });
				await this.userDataSyncService.pull();
				break;
		}
	}

	private async turnOff(): Promise<void> {
		const result = await this.dialogService.confirm({
			type: 'info',
			message: localize('turn off sync confirmation', "Do you want to turn off sync?"),
			detail: localize('turn off sync detail', "Your settings, keybindings, extensions and UI State will no longer be synced."),
			primaryButton: localize('turn off', "Turn Off"),
			checkbox: {
				label: localize('turn off sync everywhere', "Turn off sync on all your devices and clear the data from the cloud.")
			}
		});
		if (result.confirmed) {
			if (result.checkboxChecked) {
				this.telemetryService.publicLog2('sync/turnOffEveryWhere');
				await this.userDataSyncService.reset();
			} else {
				await this.userDataSyncService.resetLocal();
			}
			this.disableSync();
		}
	}

	private disableSync(source?: SyncResource): void {
		if (source === undefined) {
			this.userDataSyncEnablementService.setEnablement(false);
		} else {
			switch (source) {
				case SyncResource.Settings: return this.userDataSyncEnablementService.setResourceEnablement(SyncResource.Settings, false);
				case SyncResource.Keybindings: return this.userDataSyncEnablementService.setResourceEnablement(SyncResource.Keybindings, false);
				case SyncResource.Snippets: return this.userDataSyncEnablementService.setResourceEnablement(SyncResource.Snippets, false);
				case SyncResource.Extensions: return this.userDataSyncEnablementService.setResourceEnablement(SyncResource.Extensions, false);
				case SyncResource.GlobalState: return this.userDataSyncEnablementService.setResourceEnablement(SyncResource.GlobalState, false);
			}
		}
	}

	private async signIn(): Promise<void> {
		try {
			await this.setActiveAccount(await this.authenticationService.login(this.userDataSyncStore!.authenticationProviderId, ['https://management.core.windows.net/.default', 'offline_access']));
		} catch (e) {
			this.notificationService.error(localize('loginFailed', "Logging in failed: {0}", e));
			throw e;
		}
	}

	private getConflictsEditorInputs(syncResource: SyncResource): DiffEditorInput[] {
		return this.editorService.editors.filter(input => {
			const resource = input instanceof DiffEditorInput ? input.master.resource : input.resource;
			return resource && getSyncResourceFromLocalPreview(resource!, this.workbenchEnvironmentService) === syncResource;
		}) as DiffEditorInput[];
	}

	private getAllConflictsEditorInputs(): IEditorInput[] {
		return this.editorService.editors.filter(input => {
			const resource = input instanceof DiffEditorInput ? input.master.resource : input.resource;
			return resource && getSyncResourceFromLocalPreview(resource!, this.workbenchEnvironmentService) !== undefined;
		});
	}

	private async handleSyncResourceConflicts(resource: SyncResource): Promise<void> {
		const syncResourceCoflicts = this.userDataSyncService.conflicts.filter(({ syncResource }) => syncResource === resource)[0];
		if (syncResourceCoflicts) {
			this.handleConflicts(syncResourceCoflicts);
		}
	}

	private async handleConflicts({ syncResource, conflicts }: SyncResourceConflicts): Promise<void> {
		for (const conflict of conflicts) {
			let label: string | undefined = undefined;
			if (syncResource === SyncResource.Settings) {
				label = localize('settings conflicts preview', "Settings Conflicts (Remote ↔ Local)");
			} else if (syncResource === SyncResource.Keybindings) {
				label = localize('keybindings conflicts preview', "Keybindings Conflicts (Remote ↔ Local)");
			} else if (syncResource === SyncResource.Snippets) {
				label = localize('snippets conflicts preview', "User Snippet Conflicts (Remote ↔ Local) - {0}", basename(conflict.local));
			}
			await this.editorService.openEditor({
				leftResource: conflict.remote,
				rightResource: conflict.local,
				label,
				options: {
					preserveFocus: false,
					pinned: true,
					revealIfVisible: true,
				},
			});
		}
	}

	private showSyncActivity(): Promise<void> {
		return this.outputService.showChannel(Constants.userDataSyncLogChannelId);
	}

	private registerActions(): void {
		this.registerTurnOnSyncAction();
		this.registerSignInAction();
		this.registerShowSettingsConflictsAction();
		this.registerShowKeybindingsConflictsAction();
		this.registerShowSnippetsConflictsAction();
		this.registerSyncStatusAction();

		this.registerTurnOffSyncAction();
		this.registerConfigureSyncAction();
		this.registerShowActivityAction();
		this.registerShowSettingsAction();
	}

	private registerTurnOnSyncAction(): void {
		const turnOnSyncWhenContext = ContextKeyExpr.and(CONTEXT_SYNC_STATE.notEqualsTo(SyncStatus.Uninitialized), CONTEXT_SYNC_ENABLEMENT.toNegated(), CONTEXT_AUTH_TOKEN_STATE.notEqualsTo(AuthStatus.Initializing));
		CommandsRegistry.registerCommand(turnOnSyncCommand.id, async () => {
			try {
				await this.turnOn();
			} catch (e) {
				if (!isPromiseCanceledError(e)) {
					this.notificationService.error(localize('turn on failed', "Error while starting Sync: {0}", toErrorMessage(e)));
				}
			}
		});
		MenuRegistry.appendMenuItem(MenuId.GlobalActivity, {
			group: '5_sync',
			command: {
				id: turnOnSyncCommand.id,
				title: localize('global activity turn on sync', "Turn on Preferences Sync...")
			},
			when: turnOnSyncWhenContext,
			order: 1
		});
		MenuRegistry.appendMenuItem(MenuId.CommandPalette, {
			command: turnOnSyncCommand,
			when: turnOnSyncWhenContext,
		});
		MenuRegistry.appendMenuItem(MenuId.MenubarPreferencesMenu, {
			group: '5_sync',
			command: {
				id: turnOnSyncCommand.id,
				title: localize('global activity turn on sync', "Turn on Preferences Sync...")
			},
			when: turnOnSyncWhenContext,
		});
	}

	private registerSignInAction(): void {
		const that = this;
		this._register(registerAction2(class StopSyncAction extends Action2 {
			constructor() {
				super({
					id: signInCommand.id,
					title: localize('sign in 2', "Preferences Sync: Sign in to sync (1)"),
					menu: {
						group: '5_sync',
						id: MenuId.GlobalActivity,
						when: ContextKeyExpr.and(CONTEXT_SYNC_STATE.notEqualsTo(SyncStatus.Uninitialized), CONTEXT_SYNC_ENABLEMENT, CONTEXT_AUTH_TOKEN_STATE.isEqualTo(AuthStatus.SignedOut)),
						order: 2
					},
				});
			}
			async run(): Promise<any> {
				try {
					await that.signIn();
				} catch (e) {
					that.notificationService.error(e);
				}
			}
		}));
	}

	private registerShowSettingsConflictsAction(): void {
		const resolveSettingsConflictsWhenContext = ContextKeyExpr.regex(CONTEXT_CONFLICTS_SOURCES.keys()[0], /.*settings.*/i);
		CommandsRegistry.registerCommand(resolveSettingsConflictsCommand.id, () => this.handleSyncResourceConflicts(SyncResource.Settings));
		MenuRegistry.appendMenuItem(MenuId.GlobalActivity, {
			group: '5_sync',
			command: {
				id: resolveSettingsConflictsCommand.id,
				title: localize('resolveConflicts_global', "Preferences Sync: Show Settings Conflicts (1)"),
			},
			when: resolveSettingsConflictsWhenContext,
			order: 2
		});
		MenuRegistry.appendMenuItem(MenuId.MenubarPreferencesMenu, {
			group: '5_sync',
			command: {
				id: resolveSettingsConflictsCommand.id,
				title: localize('resolveConflicts_global', "Preferences Sync: Show Settings Conflicts (1)"),
			},
			when: resolveSettingsConflictsWhenContext,
			order: 2
		});
		MenuRegistry.appendMenuItem(MenuId.CommandPalette, {
			command: resolveSettingsConflictsCommand,
			when: resolveSettingsConflictsWhenContext,
		});
	}

	private registerShowKeybindingsConflictsAction(): void {
		const resolveKeybindingsConflictsWhenContext = ContextKeyExpr.regex(CONTEXT_CONFLICTS_SOURCES.keys()[0], /.*keybindings.*/i);
		CommandsRegistry.registerCommand(resolveKeybindingsConflictsCommand.id, () => this.handleSyncResourceConflicts(SyncResource.Keybindings));
		MenuRegistry.appendMenuItem(MenuId.GlobalActivity, {
			group: '5_sync',
			command: {
				id: resolveKeybindingsConflictsCommand.id,
				title: localize('resolveKeybindingsConflicts_global', "Preferences Sync: Show Keybindings Conflicts (1)"),
			},
			when: resolveKeybindingsConflictsWhenContext,
			order: 2
		});
		MenuRegistry.appendMenuItem(MenuId.MenubarPreferencesMenu, {
			group: '5_sync',
			command: {
				id: resolveKeybindingsConflictsCommand.id,
				title: localize('resolveKeybindingsConflicts_global', "Preferences Sync: Show Keybindings Conflicts (1)"),
			},
			when: resolveKeybindingsConflictsWhenContext,
			order: 2
		});
		MenuRegistry.appendMenuItem(MenuId.CommandPalette, {
			command: resolveKeybindingsConflictsCommand,
			when: resolveKeybindingsConflictsWhenContext,
		});
	}

	private _snippetsConflictsActionsDisposable: DisposableStore = new DisposableStore();
	private registerShowSnippetsConflictsAction(): void {
		this._snippetsConflictsActionsDisposable.clear();
		const resolveSnippetsConflictsWhenContext = ContextKeyExpr.regex(CONTEXT_CONFLICTS_SOURCES.keys()[0], /.*snippets.*/i);
		const conflicts: Conflict[] | undefined = this.userDataSyncService.conflicts.filter(({ syncResource }) => syncResource === SyncResource.Snippets)[0]?.conflicts;
		this._snippetsConflictsActionsDisposable.add(CommandsRegistry.registerCommand(resolveSnippetsConflictsCommand.id, () => this.handleSyncResourceConflicts(SyncResource.Snippets)));
		this._snippetsConflictsActionsDisposable.add(MenuRegistry.appendMenuItem(MenuId.GlobalActivity, {
			group: '5_sync',
			command: {
				id: resolveSnippetsConflictsCommand.id,
				title: localize('resolveSnippetsConflicts_global', "Preferences Sync: Show User Snippets Conflicts ({0})", conflicts?.length || 1),
			},
			when: resolveSnippetsConflictsWhenContext,
			order: 2
		}));
		this._snippetsConflictsActionsDisposable.add(MenuRegistry.appendMenuItem(MenuId.MenubarPreferencesMenu, {
			group: '5_sync',
			command: {
				id: resolveSnippetsConflictsCommand.id,
				title: localize('resolveSnippetsConflicts_global', "Preferences Sync: Show User Snippets Conflicts ({0})", conflicts?.length || 1),
			},
			when: resolveSnippetsConflictsWhenContext,
			order: 2
		}));
		this._snippetsConflictsActionsDisposable.add(MenuRegistry.appendMenuItem(MenuId.CommandPalette, {
			command: resolveSnippetsConflictsCommand,
			when: resolveSnippetsConflictsWhenContext,
		}));
	}

	private registerSyncStatusAction(): void {
		const that = this;
		const when = ContextKeyExpr.and(CONTEXT_SYNC_ENABLEMENT, CONTEXT_AUTH_TOKEN_STATE.isEqualTo(AuthStatus.SignedIn), CONTEXT_SYNC_STATE.notEqualsTo(SyncStatus.Uninitialized));
		this._register(registerAction2(class SyncStatusAction extends Action2 {
			constructor() {
				super({
					id: 'workbench.userData.actions.syncStatus',
					title: localize('sync is on', "Preferences sync is on"),
					menu: [
						{
							id: MenuId.GlobalActivity,
							group: '5_sync',
							when,
							order: 3
						},
						{
							id: MenuId.MenubarPreferencesMenu,
							group: '5_sync',
							when,
							order: 3,
						}
					],
				});
			}
			run(accessor: ServicesAccessor): any {
				return new Promise((c, e) => {
					const quickInputService = accessor.get(IQuickInputService);
					const commandService = accessor.get(ICommandService);
					const disposables = new DisposableStore();
					const quickPick = quickInputService.createQuickPick();
					disposables.add(quickPick);
					const items: Array<IQuickPickItem | IQuickPickSeparator> = [];
					if (that.userDataSyncService.conflicts.length) {
						for (const { syncResource } of that.userDataSyncService.conflicts) {
							switch (syncResource) {
								case SyncResource.Settings:
									items.push({ id: resolveSettingsConflictsCommand.id, label: resolveSettingsConflictsCommand.title });
									break;
								case SyncResource.Keybindings:
									items.push({ id: resolveKeybindingsConflictsCommand.id, label: resolveKeybindingsConflictsCommand.title });
									break;
								case SyncResource.Snippets:
									items.push({ id: resolveSnippetsConflictsCommand.id, label: resolveSnippetsConflictsCommand.title });
									break;
							}
						}
						items.push({ type: 'separator' });
					}
					items.push({ id: configureSyncCommand.id, label: configureSyncCommand.title });
					items.push({ id: showSyncSettingsCommand.id, label: showSyncSettingsCommand.title });
					items.push({ id: showSyncActivityCommand.id, label: showSyncActivityCommand.title(that.userDataSyncService) });
					items.push({ type: 'separator' });
					items.push({ id: stopSyncCommand.id, label: stopSyncCommand.title(that.userDataSyncStore!.authenticationProviderId, that.activeAccount, that.authenticationService) });
					quickPick.items = items;
					disposables.add(quickPick.onDidAccept(() => {
						if (quickPick.selectedItems[0] && quickPick.selectedItems[0].id) {
							commandService.executeCommand(quickPick.selectedItems[0].id);
						}
						quickPick.hide();
					}));
					disposables.add(quickPick.onDidHide(() => {
						disposables.dispose();
						c();
					}));
					quickPick.show();
				});
			}
		}));
	}

	private registerTurnOffSyncAction(): void {
		const that = this;
		this._register(registerAction2(class StopSyncAction extends Action2 {
			constructor() {
				super({
					id: stopSyncCommand.id,
					title: stopSyncCommand.title(that.userDataSyncStore!.authenticationProviderId, that.activeAccount, that.authenticationService),
					menu: {
						id: MenuId.CommandPalette,
						when: ContextKeyExpr.and(CONTEXT_SYNC_STATE.notEqualsTo(SyncStatus.Uninitialized), CONTEXT_SYNC_ENABLEMENT),
					},
				});
			}
			async run(): Promise<any> {
				try {
					await that.turnOff();
				} catch (e) {
					if (!isPromiseCanceledError(e)) {
						that.notificationService.error(localize('turn off failed', "Error while turning off sync: {0}", toErrorMessage(e)));
					}
				}
			}
		}));
	}

	private registerConfigureSyncAction(): void {
		const that = this;
		this._register(registerAction2(class ShowSyncActivityAction extends Action2 {
			constructor() {
				super({
					id: configureSyncCommand.id,
					title: configureSyncCommand.title,
					menu: {
						id: MenuId.CommandPalette,
						when: ContextKeyExpr.and(CONTEXT_SYNC_STATE.notEqualsTo(SyncStatus.Uninitialized), CONTEXT_SYNC_ENABLEMENT),
					},
				});
			}
			run(): any { return that.configureSyncOptions(); }
		}));
	}

	private registerShowActivityAction(): void {
		const that = this;
		this._register(registerAction2(class ShowSyncActivityAction extends Action2 {
			constructor() {
				super({
					id: showSyncActivityCommand.id,
					get title() { return showSyncActivityCommand.title(that.userDataSyncService); },
					menu: {
						id: MenuId.CommandPalette,
						when: ContextKeyExpr.and(CONTEXT_SYNC_STATE.notEqualsTo(SyncStatus.Uninitialized)),
					},
				});
			}
			run(): any { return that.showSyncActivity(); }
		}));
	}

	private registerShowSettingsAction(): void {
		this._register(registerAction2(class ShowSyncSettingsAction extends Action2 {
			constructor() {
				super({
					id: showSyncSettingsCommand.id,
					title: showSyncSettingsCommand.title,
					menu: {
						id: MenuId.CommandPalette,
						when: ContextKeyExpr.and(CONTEXT_SYNC_STATE.notEqualsTo(SyncStatus.Uninitialized)),
					},
				});
			}
			run(accessor: ServicesAccessor): any {
				accessor.get(IPreferencesService).openGlobalSettings(false, { query: '@tag:sync' });
			}
		}));
	}

}

class UserDataRemoteContentProvider implements ITextModelContentProvider {

	constructor(
		@IUserDataSyncService private readonly userDataSyncService: IUserDataSyncService,
		@IModelService private readonly modelService: IModelService,
		@IModeService private readonly modeService: IModeService,
	) {
	}

	provideTextContent(uri: URI): Promise<ITextModel> | null {
		if (uri.scheme === USER_DATA_SYNC_SCHEME) {
			return this.userDataSyncService.resolveContent(uri).then(content => this.modelService.createModel(content || '', this.modeService.create('jsonc'), uri));
		}
		return null;
	}
}

class AcceptChangesContribution extends Disposable implements IEditorContribution {

	static get(editor: ICodeEditor): AcceptChangesContribution {
		return editor.getContribution<AcceptChangesContribution>(AcceptChangesContribution.ID);
	}

	public static readonly ID = 'editor.contrib.acceptChangesButton';

	private acceptChangesButton: FloatingClickWidget | undefined;

	constructor(
		private editor: ICodeEditor,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IUserDataSyncService private readonly userDataSyncService: IUserDataSyncService,
		@INotificationService private readonly notificationService: INotificationService,
		@IDialogService private readonly dialogService: IDialogService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ITelemetryService private readonly telemetryService: ITelemetryService
	) {
		super();

		this.update();
		this.registerListeners();
	}

	private registerListeners(): void {
		this._register(this.editor.onDidChangeModel(() => this.update()));
		this._register(this.userDataSyncService.onDidChangeConflicts(() => this.update()));
		this._register(Event.filter(this.configurationService.onDidChangeConfiguration, e => e.affectsConfiguration('diffEditor.renderSideBySide'))(() => this.update()));
	}

	private update(): void {
		if (!this.shouldShowButton(this.editor)) {
			this.disposeAcceptChangesWidgetRenderer();
			return;
		}

		this.createAcceptChangesWidgetRenderer();
	}

	private shouldShowButton(editor: ICodeEditor): boolean {
		const model = editor.getModel();
		if (!model) {
			return false; // we need a model
		}

		const syncResourceConflicts = this.getSyncResourceConflicts(model.uri);
		if (!syncResourceConflicts) {
			return false;
		}

		if (syncResourceConflicts.conflicts.some(({ local }) => isEqual(local, model.uri))) {
			return true;
		}

		if (syncResourceConflicts.conflicts.some(({ remote }) => isEqual(remote, model.uri))) {
			return this.configurationService.getValue<boolean>('diffEditor.renderSideBySide');
		}

		return false;
	}


	private createAcceptChangesWidgetRenderer(): void {
		if (!this.acceptChangesButton) {
			const resource = this.editor.getModel()!.uri;
			const syncResourceConflicts = this.getSyncResourceConflicts(resource)!;
			const isRemote = syncResourceConflicts.conflicts.some(({ remote }) => isEqual(remote, resource));
			const acceptRemoteLabel = localize('accept remote', "Accept Remote");
			const acceptLocalLabel = localize('accept local', "Accept Local");
			this.acceptChangesButton = this.instantiationService.createInstance(FloatingClickWidget, this.editor, isRemote ? acceptRemoteLabel : acceptLocalLabel, null);
			this._register(this.acceptChangesButton.onClick(async () => {
				const model = this.editor.getModel();
				if (model) {
					this.telemetryService.publicLog2<{ source: string, action: string }, SyncConflictsClassification>('sync/handleConflicts', { source: syncResourceConflicts.syncResource, action: isRemote ? 'acceptRemote' : 'acceptLocal' });
					const syncAreaLabel = getSyncAreaLabel(syncResourceConflicts.syncResource);
					const result = await this.dialogService.confirm({
						type: 'info',
						title: isRemote
							? localize('Sync accept remote', "Preferences Sync: {0}", acceptRemoteLabel)
							: localize('Sync accept local', "Preferences Sync: {0}", acceptLocalLabel),
						message: isRemote
							? localize('confirm replace and overwrite local', "Would you like to accept remote {0} and replace local {1}?", syncAreaLabel.toLowerCase(), syncAreaLabel.toLowerCase())
							: localize('confirm replace and overwrite remote', "Would you like to accept local {0} and replace remote {1}?", syncAreaLabel.toLowerCase(), syncAreaLabel.toLowerCase()),
						primaryButton: isRemote ? acceptRemoteLabel : acceptLocalLabel
					});
					if (result.confirmed) {
						try {
							await this.userDataSyncService.acceptConflict(model.uri, model.getValue());
						} catch (e) {
							if (e instanceof UserDataSyncError && e.code === UserDataSyncErrorCode.LocalPreconditionFailed) {
								const syncResourceCoflicts = this.userDataSyncService.conflicts.filter(({ syncResource }) => syncResource === syncResourceConflicts.syncResource)[0];
								if (syncResourceCoflicts && syncResourceCoflicts.conflicts.some(conflict => isEqual(conflict.local, model.uri) || isEqual(conflict.remote, model.uri))) {
									this.notificationService.warn(localize('update conflicts', "Could not resolve conflicts as there is new local version available. Please try again."));
								}
							} else {
								this.notificationService.error(e);
							}
						}
					}
				}
			}));

			this.acceptChangesButton.render();
		}
	}

	private getSyncResourceConflicts(resource: URI): SyncResourceConflicts | undefined {
		return this.userDataSyncService.conflicts.filter(({ conflicts }) => conflicts.some(({ local, remote }) => isEqual(local, resource) || isEqual(remote, resource)))[0];
	}

	private disposeAcceptChangesWidgetRenderer(): void {
		dispose(this.acceptChangesButton);
		this.acceptChangesButton = undefined;
	}

	dispose(): void {
		this.disposeAcceptChangesWidgetRenderer();
		super.dispose();
	}
}
