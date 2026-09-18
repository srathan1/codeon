import * as vscode from 'vscode';

/**
 * Default context window (tokens) for a model that hasn't been given an
 * explicit value — either a freshly-added model where the user didn't
 * override the default, or a model saved before this field existed. Chosen
 * as a generous default for modern models; per-model override happens at
 * add/edit time in the UI (P6-T16 — context window moved from a single
 * global VS Code setting to a per-model field, since different models
 * genuinely have different limits).
 */
export const DEFAULT_CONTEXT_WINDOW_SIZE = 180000;

/** A model saved in the user's list, scoped to one provider. */
export interface SavedModel {
    name: string;
    provider: string;
    nickname?: string;
    /** Context window in tokens for this specific model. Defaults to DEFAULT_CONTEXT_WINDOW_SIZE when unset. */
    contextWindowSize?: number;
}

/** Active model configuration stored in globalState. */
export interface ActiveModelConfig {
    modelName: string;
    modelEndpoint: string;
    apiKey: string;
    contextWindowSize: number;
}

/** Callback notified when the active model changes so the parent can recreate ApiClient. */
export type OnModelChangedCallback = () => void;

const ACTIVE_MODEL_KEY = 'activeModel';

export class ModelManager {
    constructor(
        private readonly extensionContext: vscode.ExtensionContext,
        private readonly post: (message: Record<string, unknown>) => void,
        private readonly onModelChanged: OnModelChangedCallback
    ) {}

    /** Return the currently active model config from globalState. */
    public getActiveConfig(): ActiveModelConfig {
        const cfg = this.extensionContext.globalState.get<ActiveModelConfig | undefined>(ACTIVE_MODEL_KEY, undefined);
        // contextWindowSize may be absent on a config stored before this field
        // existed — default it rather than sending `undefined` downstream.
        if (cfg) return { ...cfg, contextWindowSize: cfg.contextWindowSize || DEFAULT_CONTEXT_WINDOW_SIZE };

        // No active model — return empty
        return { modelName: '', modelEndpoint: '', apiKey: '', contextWindowSize: DEFAULT_CONTEXT_WINDOW_SIZE };
    }

    /** Set the active model config in globalState (used internally after switch/update). */
    private async setActiveConfig(cfg: ActiveModelConfig): Promise<void> {
        await this.extensionContext.globalState.update(ACTIVE_MODEL_KEY, cfg);
    }

    /** Look up a nickname for a model by name. */
    public getModelNickname(modelName: string): string | undefined {
        const models = this.extensionContext.globalState.get<SavedModel[]>('savedModels2', []);
        return models.find(m => m.name === modelName)?.nickname;
    }

    public listModels(): void {
        const providers = this.extensionContext.globalState.get<Record<string, { endpoint: string; apiKey: string }>>('modelProviders', {});
        const models = this.extensionContext.globalState.get<SavedModel[]>('savedModels2', []);
        const currentModel = this.getActiveConfig().modelName;

        // Ensure the active model appears in the list even if not yet saved
        if (currentModel && !models.some(m => m.name === currentModel)) {
            let providerKey = Object.keys(providers)[0] || 'Default';
            models.unshift({ name: currentModel, provider: providerKey });
        }

        this.post({
            command: 'modelsList',
            providers,
            models,
            currentModel
        });
    }

    public async switchModel(modelName: string, providerName?: string): Promise<void> {
        const providers = this.extensionContext.globalState.get<Record<string, { endpoint: string; apiKey: string }>>('modelProviders', {});
        const models = this.extensionContext.globalState.get<SavedModel[]>('savedModels2', []);

        let provider = providerName;
        const modelEntry = models.find(m => m.name === modelName && (!providerName || m.provider === providerName));
        if (!provider) {
            provider = modelEntry?.provider;
        }

        const cfg = provider ? providers[provider] : null;

        const newConfig: ActiveModelConfig = {
            modelName,
            modelEndpoint: cfg?.endpoint || '',
            apiKey: cfg?.apiKey || '',
            contextWindowSize: modelEntry?.contextWindowSize || DEFAULT_CONTEXT_WINDOW_SIZE,
        };
        // H-8: await the write before notifying/reading back — previously
        // fire-and-forget, so onModelChanged() (which recreates ApiClient
        // from getActiveConfig()) could run before the new config actually
        // persisted, and a failed write failed silently with no error.
        await this.setActiveConfig(newConfig);

        this.onModelChanged();
        const nickname = modelEntry?.nickname;
        this.post({ command: 'modelSwitched', modelName, modelNickname: nickname });
    }

    public async addModel(providerName: string, providerEndpoint: string, providerApiKey: string, modelName: string, contextWindowSize?: number): Promise<void> {
        await this.bulkAddModels(providerName, providerEndpoint, providerApiKey, [{ name: modelName, contextWindowSize }]);
    }

    public async bulkAddModels(
        providerName: string,
        providerEndpoint: string,
        providerApiKey: string,
        modelSpecs: Array<{ name: string; contextWindowSize?: number }>
    ): Promise<void> {
        if (modelSpecs.length === 0) return;

        const providers = this.extensionContext.globalState.get<Record<string, { endpoint: string; apiKey: string }>>('modelProviders', {});
        const models = this.extensionContext.globalState.get<SavedModel[]>('savedModels2', []);

        const existingProvider = providers[providerName];
        if (!existingProvider) {
            providers[providerName] = { endpoint: providerEndpoint || '', apiKey: providerApiKey || '' };
        } else if (providerEndpoint || providerApiKey) {
            providers[providerName] = {
                endpoint: providerEndpoint || existingProvider.endpoint,
                apiKey: providerApiKey || existingProvider.apiKey,
            };
        }
        await this.extensionContext.globalState.update('modelProviders', providers);

        const newlyAdded: string[] = [];
        for (const spec of modelSpecs) {
            if (!spec.name) continue;
            if (!models.some(m => m.name === spec.name && m.provider === providerName)) {
                models.push({
                    name: spec.name,
                    provider: providerName,
                    contextWindowSize: spec.contextWindowSize || DEFAULT_CONTEXT_WINDOW_SIZE,
                });
                newlyAdded.push(spec.name);
            }
        }
        await this.extensionContext.globalState.update('savedModels2', models);

        // Switch to first newly added model
        if (newlyAdded.length > 0) {
            await this.switchModel(newlyAdded[0], providerName);
        }

        this.listModels();
    }

    public async addModelToProvider(modelName: string, providerName: string, contextWindowSize?: number): Promise<void> {
        const models = this.extensionContext.globalState.get<SavedModel[]>('savedModels2', []);

        if (!models.some(m => m.name === modelName && m.provider === providerName)) {
            models.push({ name: modelName, provider: providerName, contextWindowSize: contextWindowSize || DEFAULT_CONTEXT_WINDOW_SIZE });
            await this.extensionContext.globalState.update('savedModels2', models);
        }

        await this.switchModel(modelName, providerName);
        this.listModels();
    }

    public async updateProvider(providerName: string, providerEndpoint: string, providerApiKey: string): Promise<void> {
        const providers = this.extensionContext.globalState.get<Record<string, { endpoint: string; apiKey: string }>>('modelProviders', {});
        const existing = providers[providerName];
        if (!existing) return;

        // M-15: the endpoint field is pre-filled with the current value in
        // the edit-provider form (main.js `editProviderEndpoint`), so a user
        // clearing it and saving is a genuine "remove this" signal — treating
        // "" the same as "not provided" (via `||`) made it impossible to ever
        // clear a saved endpoint. The API key field is intentionally the
        // opposite: it's never pre-filled ("leave blank to keep" is its own
        // placeholder text), so "" there really does mean "unchanged," not
        // "clear" — that field's `||` fallback is correct as-is and left
        // untouched.
        providers[providerName] = {
            endpoint: providerEndpoint,
            apiKey: providerApiKey || existing.apiKey,
        };
        await this.extensionContext.globalState.update('modelProviders', providers);

        // If active model uses this provider, update its config
        const active = this.getActiveConfig();
        const models = this.extensionContext.globalState.get<SavedModel[]>('savedModels2', []);
        const activeEntry = models.find(m => m.name === active.modelName);
        if (activeEntry?.provider === providerName) {
            await this.setActiveConfig({
                modelName: active.modelName,
                modelEndpoint: providers[providerName].endpoint,
                apiKey: providers[providerName].apiKey,
                contextWindowSize: activeEntry.contextWindowSize || DEFAULT_CONTEXT_WINDOW_SIZE,
            });
            this.onModelChanged();
        }

        this.post({ command: 'modelSwitched', modelName: active.modelName });
    }

    public async updateModel(
        oldModelName: string,
        oldProviderName: string,
        newModelName: string,
        newProviderName: string,
        providerEndpoint: string,
        providerApiKey: string,
        nickname?: string | null,
        contextWindowSize?: number
    ): Promise<void> {
        const providers = this.extensionContext.globalState.get<Record<string, { endpoint: string; apiKey: string }>>('modelProviders', {});
        const models = this.extensionContext.globalState.get<SavedModel[]>('savedModels2', []);

        // null means clear, "" or undefined means preserve existing
        const oldEntry = models.find(m => m.name === oldModelName && m.provider === oldProviderName);
        const finalNickname = (nickname === null) ? undefined : (nickname || (oldEntry?.nickname ?? undefined));
        const finalContextWindowSize = contextWindowSize || oldEntry?.contextWindowSize || DEFAULT_CONTEXT_WINDOW_SIZE;

        if (newProviderName !== oldProviderName && !providers[newProviderName]) {
            providers[newProviderName] = { endpoint: providerEndpoint || '', apiKey: providerApiKey || '' };
            await this.extensionContext.globalState.update('modelProviders', providers);
        } else if (providerEndpoint || providerApiKey) {
            const existing = providers[newProviderName];
            if (existing) {
                providers[newProviderName] = {
                    endpoint: providerEndpoint || existing.endpoint,
                    apiKey: providerApiKey || existing.apiKey,
                };
                await this.extensionContext.globalState.update('modelProviders', providers);
            }
        }

        const oldIdx = models.findIndex(m => m.name === oldModelName && m.provider === oldProviderName);
        if (oldIdx >= 0) models.splice(oldIdx, 1);

        if (!models.some(m => m.name === newModelName && m.provider === newProviderName)) {
            models.push({ name: newModelName, provider: newProviderName, nickname: finalNickname || undefined, contextWindowSize: finalContextWindowSize });
        } else {
            const existing = models.find(m => m.name === newModelName && m.provider === newProviderName);
            if (existing) {
                existing.nickname = finalNickname || undefined;
                existing.contextWindowSize = finalContextWindowSize;
            }
        }
        await this.extensionContext.globalState.update('savedModels2', models);

        // If active model was renamed, update it
        const active = this.getActiveConfig();
        if (active.modelName === oldModelName) {
            const cfg = providers[newProviderName];
            await this.setActiveConfig({
                modelName: newModelName,
                modelEndpoint: cfg?.endpoint || '',
                apiKey: cfg?.apiKey || '',
                contextWindowSize: finalContextWindowSize,
            });
            this.onModelChanged();
        }

        this.listModels();
    }

    public async deleteModel(modelName: string, providerName: string): Promise<void> {
        const models = this.extensionContext.globalState.get<SavedModel[]>('savedModels2', []);
        const idx = models.findIndex(m => m.name === modelName && m.provider === providerName);
        if (idx >= 0) models.splice(idx, 1);
        await this.extensionContext.globalState.update('savedModels2', models);

        const active = this.getActiveConfig();
        if (active.modelName === modelName) {
            if (models.length > 0) {
                const fallback = models[0];
                await this.switchModel(fallback.name, fallback.provider);
            } else {
                await this.setActiveConfig({ modelName: '', modelEndpoint: '', apiKey: '', contextWindowSize: DEFAULT_CONTEXT_WINDOW_SIZE });
                this.onModelChanged();
            }
        }

        this.listModels();
    }

    /** Delete a provider and all its models. */
    public async deleteProvider(providerName: string): Promise<void> {
        const providers = this.extensionContext.globalState.get<Record<string, { endpoint: string; apiKey: string }>>('modelProviders', {});
        const models = this.extensionContext.globalState.get<SavedModel[]>('savedModels2', []);

        delete providers[providerName];
        await this.extensionContext.globalState.update('modelProviders', providers);

        const filtered = models.filter(m => m.provider !== providerName);
        await this.extensionContext.globalState.update('savedModels2', filtered);

        // If active model was under this provider, switch to first remaining or clear
        const active = this.getActiveConfig();
        if (active.modelName && !filtered.some(m => m.name === active.modelName)) {
            if (filtered.length > 0) {
                await this.switchModel(filtered[0].name, filtered[0].provider);
            } else {
                await this.setActiveConfig({ modelName: '', modelEndpoint: '', apiKey: '', contextWindowSize: DEFAULT_CONTEXT_WINDOW_SIZE });
                this.onModelChanged();
            }
        }

        this.listModels();
    }

    /** Reset all models and providers to clean state. */
    public async resetAllModels(): Promise<void> {
        await this.extensionContext.globalState.update('modelProviders', {});
        await this.extensionContext.globalState.update('savedModels2', []);
        await this.extensionContext.globalState.update(ACTIVE_MODEL_KEY, undefined);
        this.onModelChanged();
        this.post({ command: 'modelsReset' });
        this.post({
            command: 'modelsList',
            providers: {},
            models: [],
            currentModel: ''
        });
    }
}
