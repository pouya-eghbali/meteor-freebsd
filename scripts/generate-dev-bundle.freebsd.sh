#!/usr/bin/env bash

set -e
set -u

# Fibers ships with compiled versions of its C code for a dozen platforms. This
# bloats our dev bundle. Remove all the ones other than our
# architecture. (Expression based on build.js in fibers source.)
shrink_fibers () {
    ls
    FIBERS_ARCH=$(node -p -e 'process.platform + "-" + process.arch + "-" + process.versions.modules')
    mv $FIBERS_ARCH ..
    rm -rf *
    mv ../$FIBERS_ARCH .
}

# Used to delete bulky subtrees. It's not an error anymore but WARNING if they
# don't exist, because that might mean it moved somewhere else and we should
# update the delete line.
delete () {
    if [ ! -e "$1" ]; then
        echo "WARNING! Nothing to clean anymore. Missing or moved?: $1"
    else
        rm -rf "$1"
    fi
}
#----------------------------------

UNAME=$(uname)
ARCH=$(uname -m)

# save number of processors to define max parallelism for build processes
# we call that via additional bash process to not get trapped on error
NPROCESSORS=$(/usr/bin/env bash -c "getconf NPROCESSORS_ONLN 2>/dev/null; exit 0")

PLATFORM="${UNAME}_${ARCH}"

# Read the bundle version from the meteor shell script.
BUNDLE_VERSION=$(fgrep 'BUNDLE_VERSION=' meteor | head -1 | awk -F '=' '{ print $2 }')
if [ -z "$BUNDLE_VERSION" ]; then
    echo "BUNDLE_VERSION not found"
    exit 1
fi

SCRIPTS_DIR=$(dirname $0)
cd "$SCRIPTS_DIR/.."
CHECKOUT_DIR=$(pwd)

DIR=$(mktemp -d -t generate-dev-bundle-XXXXXXXX)
trap 'rm -rf "$DIR" >/dev/null 2>&1' 0

cd "$DIR"
chmod 755 .
umask 022
mkdir build
cd build

echo CHECKOUT DIR IS "$CHECKOUT_DIR"
echo BUILDING DEV BUNDLE "$BUNDLE_VERSION" IN "$DIR"

cd "$DIR"

# For an universal build we can use a self compiled tarballs for
# node and mongo or system installed binaries

# test for system installed binaries
if [ -z "$(which node 2>/dev/null)" -o -z "$(which npm 2>/dev/null)" ] ; then
    echo "To generate dev bundle with system binaries please make sure"
    echo "that node and npm is installed."
    echo -e "\tnode version:" $(which node 2>/dev/null)
    echo -e "\tnpm version:" $(which npm 2>/dev/null)
    exit 1
fi

# link to pre-installed binaries on universal build
# also need etc for "global" npmrc
mkdir -p "$DIR/bin"
mkdir -p "$DIR/lib"
ln -s "$(which node 2>/dev/null)" "$DIR/bin/node"
ln -s "$(which npm 2>/dev/null)"  "$DIR/bin/npm"

# test for system installed binaries
if [ -z "$(which mongo 2>/dev/null)" -o -z "$(which mongod 2>/dev/null)" ] ; then
    echo "To generate dev bundle with system binaries please make sure"
    echo "that mongo and mongod is installed."
    echo -e "\tmongo version:" $(which mongo 2>/dev/null)
    echo -e "\tmongod version:" $(which mongod 2>/dev/null)
    exit 1
fi

# link to pre-installed binaries on universal build
mkdir -p "$DIR/mongodb/bin"
ln -s "$(which mongo 2>/dev/null)"  "$DIR/mongodb/bin/mongo"
ln -s "$(which mongod 2>/dev/null)" "$DIR/mongodb/bin/mongod"

# export path so we use the downloaded node and npm
export PATH="$DIR/bin:$PATH"

cd "$DIR/lib"
which node
which npm
npm version

# When adding new node modules (or any software) to the dev bundle,
# remember to update LICENSE.txt! Also note that we include all the
# packages that these depend on, so watch out for new dependencies when
# you update version numbers.

# First, we install the modules that are dependencies of tools/server/boot.js:
# the modules that users of 'meteor bundle' will also have to install. We save a
# shrinkwrap file with it, too.  We do this in a separate place from
# $DIR/server-lib/node_modules originally, because otherwise 'npm shrinkwrap'
# will get confused by the pre-existing modules.
mkdir "${DIR}/build/npm-server-install"
cd "${DIR}/build/npm-server-install"
node "${CHECKOUT_DIR}/scripts/dev-bundle-server-package.js" >package.json
npm install
npm shrinkwrap

mkdir -p "${DIR}/server-lib/node_modules"
# This ignores the stuff in node_modules/.bin, but that's OK.
cp -R node_modules/* "${DIR}/server-lib/node_modules/"

mkdir -p "${DIR}/etc"
mv package.json npm-shrinkwrap.json "${DIR}/etc/"

cd "$DIR/server-lib/node_modules/fibers/bin"
shrink_fibers

# Now, install the npm modules which are the dependencies of the command-line
# tool.
mkdir "${DIR}/build/npm-tool-install"
cd "${DIR}/build/npm-tool-install"
node "${CHECKOUT_DIR}/scripts/dev-bundle-tool-package.js" >package.json
npm install
mkdir -p "${DIR}/lib/node_modules/"
cp -R node_modules/* "${DIR}/lib/node_modules/"
# Also include node_modules/.bin, so that `meteor npm` can make use of
# commands like node-gyp and node-pre-gyp.
cp -R node_modules/.bin "${DIR}/lib/node_modules/"

cd "${DIR}/lib"

# Clean up some bulky stuff.
cd node_modules

delete browserstack-webdriver/docs
delete browserstack-webdriver/lib/test

delete sqlite3/deps
delete wordwrap/test
delete moment/min

# Remove esprima tests to reduce the size of the dev bundle
find . -path '*/esprima-fb/test' | xargs rm -rf

cd "$DIR/lib/node_modules/fibers/bin"
shrink_fibers

# Sanity check to see if we're not breaking anything by replacing npm
INSTALLED_NPM_VERSION=$(cat "$DIR/lib/node_modules/npm/package.json" |
xargs -0 node -e "console.log(JSON.parse(process.argv[1]).version)")

echo BUNDLING

cd "$DIR"
echo "${BUNDLE_VERSION}" > .bundle_version.txt
rm -rf build CHANGELOG.md ChangeLog LICENSE README.md

tar czf "${CHECKOUT_DIR}/dev_bundle_${PLATFORM}_${BUNDLE_VERSION}.tar.gz" .

echo DONE