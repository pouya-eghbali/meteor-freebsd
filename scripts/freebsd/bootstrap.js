var main = require('../../tools/cli/main.js');
var _ = require('underscore');
var files = require('../../tools/fs/files');
var buildmessage = require('../../tools/utils/buildmessage.js');
var config = require('../../tools/meteor-services/config.js');
var utils = require('../../tools/utils/utils.js');
var catalog = require('../../tools/packaging/catalog/catalog.js');
var catalogRemote = require('../../tools/packaging/catalog/catalog-remote.js');
var isopack = require('../../tools/isobuild/isopack.js');
var Console = require('../../tools/console/console.js').Console;
var catalogUtils = require('../../tools/packaging/catalog/catalog-utils.js');

var packageMapModule = require('../../tools/packaging/package-map.js');
var packageClient = require('../../tools/packaging/package-client.js');
var tropohouse = require('../../tools/packaging/tropohouse.js');

const argv = require('minimist')(process.argv);

console.log(argv);

const makeBootstrapTarballsFreeBSD = options => {
  var releaseNameAndVersion = options.args[0];

  // We get this as an argument, so it is an OS path. Make it a standard path.
  var outputDirectory = files.convertToStandardPath(options.args[1]);

  var trackAndVersion = catalogUtils.splitReleaseName(releaseNameAndVersion);
  var releaseTrack = trackAndVersion[0];
  var releaseVersion = trackAndVersion[1];

  var releaseRecord = catalog.official.getReleaseVersion(
    releaseTrack, releaseVersion);
  if (!releaseRecord) {
    // XXX this could also mean package unknown.
    Console.error('Release unknown: ' + releaseNameAndVersion + '');
    return 1;
  }

  var toolPackageVersion = releaseRecord.tool &&
    utils.parsePackageAndVersion(releaseRecord.tool);
  if (!toolPackageVersion) {
    throw new Error("bad tool in release: " + releaseRecord.tool);
  }
  var toolPackage = toolPackageVersion.package;
  var toolVersion = toolPackageVersion.version;

  var toolPkgBuilds = catalog.official.getAllBuilds(
    toolPackage, toolVersion);
  if (!toolPkgBuilds) {
    // XXX this could also mean package unknown.
    Console.error('Tool version unknown: ' + releaseRecord.tool);
    return 1;
  }
  if (!toolPkgBuilds.length) {
    Console.error('Tool version has no builds: ' + releaseRecord.tool);
    return 1;
  }

  // XXX check to make sure this is the three arches that we want? it's easier
  // during 0.9.0 development to allow it to just decide "ok, i just want to
  // build the OSX tarball" though.
  var buildArches = _.pluck(toolPkgBuilds, 'buildArchitectures');
  var osArches = _.map(buildArches, function (buildArch) {
    var subArches = buildArch.split('+');
    var osArches = _.filter(subArches, function (subArch) {
      return subArch.substr(0, 3) === 'os.';
    });
    if (osArches.length !== 1) {
      throw Error("build architecture " + buildArch + "  lacks unique os.*");
    }
    return osArches[0];
  });

  if (options['target-arch']) {
    // check if the passed arch is in the list
    var arch = options['target-arch'];
    if (!_.contains(osArches, arch)) {
      throw new Error(
        arch + ": the arch is not available for the release. Available arches: "
        + osArches.join(', '));
    }

    // build only for the selected arch
    osArches = [arch];
  }

  Console.error(
    'Building bootstrap tarballs for architectures ' + osArches.join(', '));

  // Before downloading anything, check that the catalog contains everything we
  // need for the OSes that the tool is built for.
  main.captureAndExit("=> Errors finding builds:", function () {
    _.each(osArches, function (osArch) {
      _.each(releaseRecord.packages, function (pkgVersion, pkgName) {
        buildmessage.enterJob({
          title: "looking up " + pkgName + "@" + pkgVersion + " on " + osArch
        }, function () {
          if (!catalog.official.getBuildsForArches(pkgName, pkgVersion, [osArch])) {
            buildmessage.error("missing build of " + pkgName + "@" + pkgVersion +
              " for " + osArch);
          }
        });
      });
    });
  });

  files.mkdir_p(outputDirectory);

  // Get a copy of the data.json.
  var dataTmpdir = files.mkdtemp();
  var tmpDataFile = files.pathJoin(dataTmpdir, 'packages.data.db');

  var tmpCatalog = new catalogRemote.RemoteCatalog();
  tmpCatalog.initialize({
    packageStorage: tmpDataFile
  });
  try {
    packageClient.updateServerPackageData(tmpCatalog, null);
  } catch (err) {
    packageClient.handlePackageServerConnectionError(err);
    return 2;
  }

  // Since we're making bootstrap tarballs, we intend to recommend this release,
  // so we should ensure that once it is downloaded, it knows it is recommended
  // rather than having a little identity crisis and thinking that a past
  // release is the latest recommended until it manages to sync.
  tmpCatalog.forceRecommendRelease(releaseTrack, releaseVersion);
  tmpCatalog.closePermanently();
  if (files.exists(tmpDataFile + '-wal')) {
    throw Error("Write-ahead log still exists for " + tmpDataFile
      + " so the data file will be incomplete!");
  }

  var packageMap =
    packageMapModule.PackageMap.fromReleaseVersion(releaseRecord);

  _.each(osArches, function (osArch) {
    var tmpdir = files.mkdtemp();
    Console.info("Building tarball for " + osArch);

    // when building for Windows architectures, build Windows-specific
    // tropohouse and bootstrap tarball
    var targetPlatform;
    if (/win/i.test(osArch)) {
      targetPlatform = "win32";
    }

    // We're going to build and tar up a tropohouse in a temporary directory.
    var tmpTropo = new tropohouse.Tropohouse(
      files.pathJoin(tmpdir, '.meteor'),
      { platform: targetPlatform });

    main.captureAndExit(
      "=> Errors downloading packages for " + osArch + ":",
      function () {
        tmpTropo.downloadPackagesMissingFromMap(packageMap, {
          serverArchitectures: [osArch]
        });
      }
    );

    // Install the sqlite DB file we synced earlier. We have previously
    // confirmed that the "-wal" file (which could contain extra log entries
    // that haven't been flushed to the main file yet) doesn't exist, so we
    // don't have to copy it.
    files.copyFile(tmpDataFile, config.getPackageStorage({
      root: tmpTropo.root
    }));

    // Create the top-level 'meteor' symlink, which links to the latest tool's
    // meteor shell script.
    var toolIsopackPath =
      tmpTropo.packagePath(toolPackage, toolVersion);
    var toolIsopack = new isopack.Isopack;
    toolIsopack.initFromPath(toolPackage, toolIsopackPath);
    var toolRecord = _.findWhere(toolIsopack.toolsOnDisk, { arch: osArch });
    if (!toolRecord) {
      throw Error("missing tool for " + osArch);
    }

    tmpTropo.linkToLatestMeteor(files.pathJoin(
      tmpTropo.packagePath(toolPackage, toolVersion, true),
      toolRecord.path,
      'meteor'));

    if (options.unpacked) {
      files.cp_r(tmpTropo.root, outputDirectory);
    } else {
      files.createTarball(
        tmpTropo.root,
        files.pathJoin(outputDirectory,
          'meteor-bootstrap-' + osArch + '.tar.gz'));
    }
  });

  return 0;
}