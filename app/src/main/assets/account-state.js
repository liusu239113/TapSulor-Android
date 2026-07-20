'use strict';

const TAPTAP_ORIGIN = 'https://developer.taptap.cn';
const LEGACY_BOOTSTRAP_DEVELOPER_ID = '381509';

function normalizeDeveloperId(value) {
  if (value == null) return null;
  const id = String(value).trim();
  return id && /^\d+$/.test(id) ? id : null;
}

function createDefaultConfig() {
  return {
    current: 'acc-1',
    accounts: [{
      id: 'acc-1',
      name: '默认账号',
      developerId: null,
      partition: 'persist:taptap'
    }]
  };
}

function isLegacyBootstrapAccount(account) {
  return Boolean(
    account &&
    account.id === 'acc-1' &&
    account.name === '默认账号' &&
    account.developerId === LEGACY_BOOTSTRAP_DEVELOPER_ID &&
    account.partition === 'persist:taptap'
  );
}

function cloneConfig(config) {
  const accounts = Array.isArray(config && config.accounts)
    ? config.accounts.map((account) => ({ ...account }))
    : [];
  return {
    current: config && config.current,
    accounts
  };
}

function reconcileSessionIdentity(config, options) {
  const developerId = normalizeDeveloperId(options && options.developerId);
  if (!developerId) throw new TypeError('A valid developer id is required');

  const sourcePartition = options && options.partition
    ? String(options.partition)
    : null;
  const now = options && options.now != null ? options.now : Date.now();
  const next = cloneConfig(config);

  if (next.accounts.length === 0) {
    Object.assign(next, createDefaultConfig());
  }

  const current = next.accounts.find((account) => account.id === next.current) || next.accounts[0];
  next.current = current.id;

  const existing = next.accounts.find((account) => (
    normalizeDeveloperId(account.developerId) === developerId &&
    !isLegacyBootstrapAccount(account)
  ));

  if (existing) {
    const action = next.current === existing.id ? 'unchanged' : 'switched';
    next.current = existing.id;
    return {
      action,
      config: next,
      account: existing,
      copyCookies: Boolean(sourcePartition && sourcePartition !== existing.partition)
    };
  }

  if (!normalizeDeveloperId(current.developerId) || isLegacyBootstrapAccount(current)) {
    current.developerId = developerId;
    if (!current.name || current.name === '默认账号') {
      current.name = `TapTap ${developerId}`;
    }
    current.partition = current.partition || sourcePartition || 'persist:taptap';
    return {
      action: 'bound',
      config: next,
      account: current,
      copyCookies: Boolean(sourcePartition && sourcePartition !== current.partition)
    };
  }

  const account = {
    id: `acc-${now}`,
    name: `TapTap ${developerId}`,
    developerId,
    partition: `persist:taptap-${developerId}`
  };
  next.accounts.push(account);
  next.current = account.id;
  return {
    action: 'created',
    config: next,
    account,
    copyCookies: Boolean(sourcePartition && sourcePartition !== account.partition)
  };
}

function getLoginStartUrl() {
  return `${TAPTAP_ORIGIN}/`;
}

function buildAppListUrl(developerId, page = 1, pageSize = 100) {
  const id = normalizeDeveloperId(developerId);
  if (!id) throw new TypeError('A valid developer id is required');

  const url = new URL('/api/app/v2/list', TAPTAP_ORIGIN);
  url.searchParams.set('developer_id', id);
  url.searchParams.set('page', String(page));
  url.searchParams.set('pagesize', String(pageSize));
  return url.toString();
}

function extractDeveloperIdFromMe(json) {
  const data = json && json.data;
  return normalizeDeveloperId(
    data && (
      data.developer_id ??
      data.developerId ??
      (data.developer && data.developer.id)
    )
  );
}

function extractDeveloperIdsFromList(json) {
  const list = json && json.data && json.data.list;
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map((item) => normalizeDeveloperId(
    item && (item.developer_id ?? item.developerId ?? item.id)
  )).filter(Boolean))];
}

function classifySessionIdentity(meResponse, developerListResponse, configuredDeveloperId) {
  if (!meResponse || meResponse.status === 401 || meResponse.status === 403) {
    return { status: 'unauthenticated', developerId: null };
  }
  if (meResponse.status === 0 || meResponse.error) {
    return {
      status: 'error',
      developerId: null,
      error: meResponse.error || 'network_error'
    };
  }

  const meDeveloperId = extractDeveloperIdFromMe(meResponse.json);
  if (meDeveloperId) {
    return { status: 'ready', developerId: meDeveloperId };
  }

  if (!developerListResponse || developerListResponse.status === 0 || developerListResponse.error) {
    return {
      status: 'error',
      developerId: null,
      error: developerListResponse && developerListResponse.error
        ? developerListResponse.error
        : 'identity_unavailable'
    };
  }

  const ids = extractDeveloperIdsFromList(developerListResponse.json);
  if (ids.length === 0) {
    return { status: 'no-developer', developerId: null };
  }

  const configuredId = normalizeDeveloperId(configuredDeveloperId);
  return {
    status: 'ready',
    developerId: configuredId && ids.includes(configuredId) ? configuredId : ids[0]
  };
}

function isTapTapDeveloperUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'developer.taptap.cn';
  } catch (error) {
    return false;
  }
}

module.exports = {
  createDefaultConfig,
  reconcileSessionIdentity,
  getLoginStartUrl,
  buildAppListUrl,
  extractDeveloperIdFromMe,
  extractDeveloperIdsFromList,
  classifySessionIdentity,
  isTapTapDeveloperUrl
};
