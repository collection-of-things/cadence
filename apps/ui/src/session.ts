import { resolveApi } from './api';
import { createUiStore } from './store';

export const api = resolveApi();
export const session = createUiStore(api);
