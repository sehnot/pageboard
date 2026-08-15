const { notarize } = require('@electron/notarize');

// electron-builder afterSign hook. Notarization is deliberately
// optional: only runs when APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/
// APPLE_TEAM_ID are set (e.g. as GitHub Actions secrets) — without these
// variables (a local build, or as long as no Apple Developer account
// exists), the step is skipped instead of failing the build.
module.exports = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;

  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;

  if (!appleId || !appleIdPassword || !teamId) {
    console.log(
      '[Notarize] Skipped (APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID not set).',
    );
    return;
  }

  const appName = context.packager.appInfo.productFilename;

  await notarize({
    appBundleId: 'com.pageboard.app',
    appPath: `${appOutDir}/${appName}.app`,
    appleId,
    appleIdPassword,
    teamId,
  });
};
