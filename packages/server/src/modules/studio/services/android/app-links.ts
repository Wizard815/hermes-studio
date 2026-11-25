/**
 * Android App Links for the Studio Own app (packages/android): Android opens
 * links to this server in the app once the server says the app may handle
 * them. Set STUDIO_OWN_ANDROID_CERT_SHA256 to the SHA-256 fingerprint of the
 * key the APK is signed with (comma-separated for several), as `keytool -list
 * -v` or `apksigner verify --print-certs` print it. Unset: nothing is served.
 */
export const STUDIO_OWN_PACKAGE = 'com.ekkostudio.own'

export function assetLinks(env: Record<string, string | undefined> = process.env): unknown[] | null {
  const fingerprints = String(env.STUDIO_OWN_ANDROID_CERT_SHA256 || '')
    .split(',')
    .map(value => value.trim().toUpperCase())
    .filter(value => /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(value))
  if (!fingerprints.length) return null
  return [{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: { namespace: 'android_app', package_name: STUDIO_OWN_PACKAGE, sha256_cert_fingerprints: fingerprints },
  }]
}
