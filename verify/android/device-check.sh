#!/bin/sh
# Runs on an Android emulator after `gradle assembleDebug` (see the workflow).
# Installs each test app, checks that the system registered its AppFunctions,
# and runs a few of them through `cmd app_function`, as a developer would.
set -u
cd "$(dirname "$0")"
status=0
fail() { echo "FAIL $*"; status=1; }

sdk=$(adb shell getprop ro.build.version.sdk | tr -d '\r')
echo "Emulator API level: $sdk"

for dir in modules/*/; do
  name=$(basename "$dir")
  apk=$(find "$dir/build/outputs/apk/debug" -name '*.apk' | head -n 1)
  pkg=$(sed -n 's/.*applicationId = "\(.*\)"/\1/p' "$dir/build.gradle.kts")
  echo "== $name ($pkg)"
  adb install -r "$apk" >/dev/null || { fail "$name: install failed"; continue; }
  sleep 3
  list=$(adb shell cmd app_function list-app-functions --package "$pkg" 2>&1)
  echo "$list" | head -n 80
  for fn in $(node -e "console.log(require('./$dir/expect.json').functions.join(' '))"); do
    echo "$list" | grep -q "#$fn" || fail "$name: $fn not registered"
  done
done

run() { # package function json expected-substring
  out=$(adb shell "cmd app_function execute-app-function --package $1 --function '$2' --parameters '$3'" 2>&1)
  echo "-- $2 $3"
  echo "$out" | head -n 40
  echo "$out" | grep -q "$4" || fail "$2 with $3: expected output to contain $4"
}

svc=com.example.todoexample.omnintent.BaseTodoExampleAppFunctionService
run com.example.todoexample "$svc#listLists" '{}' groceries
run com.example.todoexample "$svc#addItem" '{"listId":"groceries","title":"Buy milk"}' 'Buy milk'
run com.example.todoexample "$svc#addItem" '{"listId":"groceries","title":"Pay rent","dueDate":"2027-04-15"}' '2027'
run com.example.todoexample "$svc#listItems" '{"listId":"groceries","status":"done"}' ''
run com.example.todoexample "$svc#listItems" '{"listId":"groceries","status":"nope"}' 'status must be one of'
run com.example.todoexample "$svc#addItem" '{"listId":"groceries","title":" "}' 'title must not be blank'

fsvc=com.example.fieldnotes.omnintent.BaseFieldNotesAppFunctionService
run com.example.fieldnotes "$fsvc#logReading" '{"label":"north creek","count":3,"samples":[1,2,3],"tags":["a"]}' 'r-1'
run com.example.fieldnotes "$fsvc#getReading" '{"readingId":"r-7"}' 'r-7'
run com.example.fieldnotes "$fsvc#syncNow" '{}' ''

exit $status
