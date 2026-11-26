import { expect, it } from 'vitest'
import { assetLinks } from '../../packages/server/src/modules/studio/services/android/app-links'

const fp = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0')).join(':')

it('serves assetlinks.json for the Studio Own app only once a signing fingerprint is set', () => {
  expect(assetLinks({})).toBeNull()
  expect(assetLinks({ STUDIO_OWN_ANDROID_CERT_SHA256: 'not-a-fingerprint' })).toBeNull()
  expect(assetLinks({ STUDIO_OWN_ANDROID_CERT_SHA256: ` ${fp} , bad ` })).toEqual([{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: { namespace: 'android_app', package_name: 'com.ekkostudio.own', sha256_cert_fingerprints: [fp.toUpperCase()] },
  }])
})
