import { createLogger } from '../core/logger.js';
import qrcode from 'qrcode';

const log = createLogger('DeviceFlow');

interface AppRegistrationResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

interface AppRegistrationResult {
  clientID: string;
  clientSecret: string;
  userInfo?: {
    openID: string;
    tenantBrand: string;
  };
}

const ACCOUNTS_ENDPOINT = 'https://accounts.feishu.cn';
const OPEN_ENDPOINT = 'https://open.feishu.cn';
const APP_REGISTRATION_PATH = '/oauth/v1/app/registration';
const MAX_POLL_ATTEMPTS = 200;
const MAX_POLL_INTERVAL = 60;
const FETCH_TIMEOUT_MS = 15000; // 15s timeout for each poll request

/**
 * Initiate the app registration device flow.
 * This calls the Feishu Open Platform API to begin device authorization.
 */
export async function requestAppRegistration(): Promise<AppRegistrationResponse> {
  const endpoint = `${ACCOUNTS_ENDPOINT}${APP_REGISTRATION_PATH}`;
  
  const form = new URLSearchParams();
  form.set('action', 'begin');
  form.set('archetype', 'PersonalAgent');
  form.set('auth_method', 'client_secret');
  form.set('request_user_info', 'open_id tenant_brand');

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
  });

  const data: any = await resp.json();

  if (!resp.ok || data.error) {
    const msg = data.error_description || data.error || 'Unknown error';
    throw new Error(`App registration failed: ${msg}`);
  }

  const userCode = data.user_code || '';
  const verificationUriComplete = `${OPEN_ENDPOINT}/page/cli?user_code=${userCode}`;

  return {
    deviceCode: data.device_code || '',
    userCode: userCode,
    verificationUri: data.verification_uri || '',
    verificationUriComplete: verificationUriComplete,
    expiresIn: data.expires_in || 300,
    interval: data.interval || 5,
  };
}

/**
 * Generate and display QR code in terminal.
 */
export async function displayQRCode(url: string): Promise<void> {
  try {
    const qr = await qrcode.toString(url, { 
      type: 'terminal',
      small: true,
    });
    console.log('\n📱 请使用飞书扫描二维码创建应用：\n');
    console.log(qr);
    console.log('\n💡 或点击链接：', url);
    console.log('⏳ 等待扫码确认...\n');
  } catch (err) {
    log.error({ err }, 'Failed to generate QR code');
    console.log('\n📱 请访问以下链接创建应用：');
    console.log('   ', url);
    console.log('⏳ 等待扫码确认...\n');
  }
}

/**
 * Poll the app registration endpoint until the app is created or timeout.
 */
export async function pollAppRegistration(
  deviceCode: string,
  interval: number,
  expiresIn: number,
): Promise<AppRegistrationResult> {
  const endpoint = `${ACCOUNTS_ENDPOINT}${APP_REGISTRATION_PATH}`;
  const deadline = Date.now() + expiresIn * 1000;
  let currentInterval = interval;
  let attempts = 0;

  while (Date.now() < deadline && attempts < MAX_POLL_ATTEMPTS) {
    attempts++;

    await new Promise(resolve => setTimeout(resolve, currentInterval * 1000));

    const form = new URLSearchParams();
    form.set('action', 'poll');
    form.set('device_code', deviceCode);

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      const data: any = await resp.json();
      const errStr = data.error || '';

      // Success: client_id present
      if (!errStr && data.client_id) {
        const result: AppRegistrationResult = {
          clientID: data.client_id,
          clientSecret: data.client_secret || '',
        };

        if (data.user_info) {
          result.userInfo = {
            openID: data.user_info.open_id || '',
            tenantBrand: data.user_info.tenant_brand || 'feishu',
          };
        }

        return result;
      }

      switch (errStr) {
        case 'authorization_pending':
          continue;
        case 'slow_down':
          currentInterval = Math.min(currentInterval + 5, MAX_POLL_INTERVAL);
          log.info({ interval: currentInterval }, 'Rate limited, increasing interval');
          continue;
        case 'access_denied':
          throw new Error('App registration denied by user');
        case 'expired_token':
        case 'invalid_grant':
          throw new Error('Device code expired, please try again');
        default:
          const desc = data.error_description || errStr || 'Unknown error';
          throw new Error(`App registration failed: ${desc}`);
      }
    } catch (err) {
      if (err instanceof Error) {
        if (err.name === 'AbortError') {
          log.warn('Poll request timed out, retrying...');
          currentInterval = Math.min(currentInterval + 2, MAX_POLL_INTERVAL);
          continue;
        }
        if (err.message.includes('denied') || err.message.includes('expired')) {
          throw err;
        }
      }
      log.warn({ err }, 'Poll error, retrying...');
      currentInterval = Math.min(currentInterval + 1, MAX_POLL_INTERVAL);
    }
  }

  if (attempts >= MAX_POLL_ATTEMPTS) {
    throw new Error('Max poll attempts reached');
  }
  throw new Error('App registration timed out');
}
