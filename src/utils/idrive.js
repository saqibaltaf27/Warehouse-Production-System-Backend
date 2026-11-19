const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const required = [
  'IDRIVE_ENDPOINT',
  'IDRIVE_REGION',
  'IDRIVE_ACCESS_KEY',
  'IDRIVE_SECRET_KEY',
  'IDRIVE_BUCKET_NAME',
];

const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  console.warn(`⚠️ iDrive config missing: ${missing.join(', ')}`);
}

const s3Client = new S3Client({
  endpoint: process.env.IDRIVE_ENDPOINT,
  region: process.env.IDRIVE_REGION || 'ap-southeast-1',
  credentials: {
    accessKeyId: process.env.IDRIVE_ACCESS_KEY || '',
    secretAccessKey: process.env.IDRIVE_SECRET_KEY || '',
  },
  forcePathStyle: true,
});

const bucket = process.env.IDRIVE_BUCKET_NAME || '';
const POLICY_FOLDER = 'pms/policy-management';

const sanitizeFileName = (name = 'file') =>
  String(name)
    .replace(/[^\w.\-()+\s]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 180);

const buildPolicyKey = (originalName) => {
  const safe = sanitizeFileName(originalName);
  return `${POLICY_FOLDER}/${Date.now()}-${safe}`;
};

const uploadPolicyFile = async ({ buffer, originalName, contentType }) => {
  const key = buildPolicyKey(originalName);
  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType || 'application/octet-stream',
    }),
  );
  return key;
};

const deletePolicyFile = async (key) => {
  if (!key) return;
  await s3Client.send(
    new DeleteObjectCommand({
      Bucket: bucket,
      Key: key,
    }),
  );
};

const getPolicyFileUrl = async (key, expiresIn = 3600) => {
  if (!key) return null;
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  });
  return getSignedUrl(s3Client, command, { expiresIn });
};

module.exports = {
  POLICY_FOLDER,
  uploadPolicyFile,
  deletePolicyFile,
  getPolicyFileUrl,
};
