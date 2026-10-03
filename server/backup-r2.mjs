import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { verifiedUpload } from './runtime-backup.mjs';

// Resolve only when an R2 backup is requested. Missing backup configuration must
// not prevent the site from starting or affect the separate resource client.
function configuration(env) {
  const bucket = String(env.BACKUP_R2_BUCKET || '').trim();
  if (!bucket || bucket === String(env.R2_BUCKET || '').trim() || env.BACKUP_R2_PRIVATE_CONFIRMED !== '1') {
    throw new Error('独立私密备份桶尚未配置并核验；本地备份已保留。');
  }
  const required = ['BACKUP_R2_ACCOUNT_ID', 'BACKUP_R2_ACCESS_KEY_ID', 'BACKUP_R2_SECRET_ACCESS_KEY'];
  if (required.some(name => typeof env[name] !== 'string' || !env[name].trim())) {
    throw new Error('私密R2备份需独立配置BACKUP_R2_ACCOUNT_ID、BACKUP_R2_ACCESS_KEY_ID及BACKUP_R2_SECRET_ACCESS_KEY；本地备份已保留。');
  }
  const account = env.BACKUP_R2_ACCOUNT_ID.trim();
  if (!/^[a-f0-9]{32}$/i.test(account)) throw new Error('BACKUP_R2_ACCOUNT_ID格式无效；本地备份已保留。');
  return {
    bucket,
    client: {
      region: 'auto',
      endpoint: `https://${account}.r2.cloudflarestorage.com`,
      forcePathStyle: true,
      maxAttempts: 2,
      credentials: {
        accessKeyId: env.BACKUP_R2_ACCESS_KEY_ID.trim(),
        secretAccessKey: env.BACKUP_R2_SECRET_ACCESS_KEY.trim(),
      },
    },
  };
}

export async function uploadPrivateR2Backup({ bytes, filename, env = process.env, createClient = options => new S3Client(options) }) {
  const config = configuration(env);
  if (typeof filename !== 'string' || !/^runtime-[a-zA-Z0-9._-]+\.json\.enc$/.test(filename)) {
    throw new Error('私密R2备份文件名无效；本地备份已保留。');
  }
  const key = `runtime-backups/${filename}`;
  let client;
  try {
    client = createClient(config.client);
    const result = await verifiedUpload(bytes, {
      put: body => client.send(new PutObjectCommand({ Bucket: config.bucket, Key: key, Body: body, ContentType: 'application/octet-stream' }), { abortSignal: AbortSignal.timeout(30_000) }),
      get: async () => {
        const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }), { abortSignal: AbortSignal.timeout(30_000) });
        return Buffer.from(await response.Body.transformToByteArray());
      },
    });
    return { key, ...result };
  } catch (error) {
    // SDK/transport error messages may contain request metadata. Return a stable
    // message and an optional status code, never credentials or raw provider text.
    const status = error?.$metadata?.httpStatusCode;
    const hint = Number.isInteger(status) && status >= 400 && status <= 599 ? `（HTTP ${status}）` : '';
    throw new Error(`私密R2上传或读回校验失败${hint}；本地备份已保留。`);
  } finally {
    client?.destroy();
  }
}
