# App icon

`AppIcon.icon` is the layered source. `Assets.car` and the two sized PNGs are
compiled from it and copied to the app bundle by xtool. The icon keys in
`Info.plist` come from the compiler's partial plist. `AppIcon.png` remains the
flat fallback used by xtool.

xtool on Linux cannot compile Icon Composer sources. To regenerate the compiled
files, run the following on a macOS GitHub Actions runner with Xcode 26, using
the contents of `AppIcon.icon` as input:

```sh
mkdir output
xcrun actool AppIcon.icon --compile output --platform iphoneos \
  --minimum-deployment-target 26.0 --app-icon AppIcon \
  --output-partial-info-plist output/icon.plist
```

Copy `Assets.car`, `AppIcon60x60@2x.png` and `AppIcon76x76@2x~ipad.png`
from `output` into this directory, and check `icon.plist` against the icon keys
in `ios/Info.plist`. Upload the output as a workflow artifact to retrieve it
from Linux. A private temporary repository can run this workflow without
changing the Milo repository's Actions setting.
