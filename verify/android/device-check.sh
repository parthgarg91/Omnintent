#!/bin/sh
# Runs on an Android emulator after `gradle assembleDebug` (see the workflow).
# Installs each test app, checks that the system registered its AppFunctions,
# and runs a few of them through `cmd app_function`, as a developer would.
set -u
cd "$(dirname "$0")"
status=0
fail() { echo "FAIL $*"; status=1; }

sdk=$(adb shell getprop ro.build.version.sdk | tr -d '\r')
echo "Emulator API level: $sdk ($(adb shell getprop ro.build.version.release | tr -d '\r'), $(adb shell getprop ro.build.fingerprint | tr -d '\r'))"
echo "AppFunction services:"; adb shell service list | grep -i function
echo "Shell commands:"; adb shell cmd -l | grep -i function

for dir in modules/*/; do
  name=$(basename "$dir")
  apk=$(find "$dir/build/outputs/apk/debug" -name '*.apk' | head -n 1)
  pkg=$(sed -n 's/.*applicationId = "\(.*\)"/\1/p' "$dir/build.gradle.kts")
  echo "== $name ($pkg)"
  adb install -r "$apk" >/dev/null || { fail "$name: install failed"; continue; }
  # Registration happens in the background after install; wait for it.
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
    sleep 5
    list=$(adb shell cmd app_function list-app-functions --package "$pkg" 2>&1)
    echo "$list" | grep -q '#' && break
  done
  echo "$list" | grep '"functionId"' -A1 | grep '#'
  for fn in $(node -e "console.log(require('./$dir/expect.json').functions.join(' '))"); do
    echo "$list" | grep -q "#$fn" || fail "$name: $fn not registered"
  done
done

run() { # package function json expected-substring [quiet]
  out=$(adb shell "cmd app_function execute-app-function --package $1 --function '$2' --parameters '$3'" 2>&1)
  if [ -z "${5:-}" ]; then
    echo "-- $2 $3"
    echo "$out" | head -n 60
  fi
  echo "$out" | grep -q "$4" || fail "$2 with $3: expected output to contain $4"
}

svc=com.example.todoexample.omnintent.BaseTodoExampleAppFunctionService
run com.example.todoexample "$svc#listLists" '{}' groceries
run com.example.todoexample "$svc#addItem" '{"listId":"groceries","title":"Buy milk"}' 'Buy milk'
# LocalDate travels as an object, not as "2027-04-15".
run com.example.todoexample "$svc#addItem" '{"listId":"work","title":"File taxes","dueDate":{"year":2027,"month":4,"dayOfMonth":15}}' '2027'
run com.example.todoexample "$svc#listItems" '{"listId":"groceries","status":"done"}' 'androidAppfunctionsReturnValue'
# The platform checks enum values against the schema before the app sees them.
run com.example.todoexample "$svc#listItems" '{"listId":"groceries","status":"nope"}' 'Parameter status should be'
# The generated blank check reaches the caller as an invalid-argument error.
run com.example.todoexample "$svc#addItem" '{"listId":"groceries","title":" "}' 'title must not be blank'

osvc=com.example.optin.omnintent.BaseTodoExampleAppFunctionService
# Opted-in destructive actions are registered disabled until the app enables them.
run com.example.optin "$osvc#deleteItem" '{"itemId":"item-1"}' 'rror'

fsvc=com.example.fieldnotes.omnintent.BaseFieldNotesAppFunctionService
# Omitted optional parameters: manifest defaults are applied in the function body.
run com.example.fieldnotes "$fsvc#logReading" '{"label":"north creek","count":3}' 'limit=10'
run com.example.fieldnotes "$fsvc#logReading" '{"label":"north creek","count":3}' 'serial=42'
run com.example.fieldnotes "$fsvc#logReading" '{"label":"north creek","count":3}' 'temperature=20.0'
run com.example.fieldnotes "$fsvc#logReading" '{"label":"north creek","count":3}' 'unit=metric'
# Every type, as an agent would send it.
all='{"label":"pond","count":2,"limit":5,"serial":9000000000,"temperature":18.5,"humidity":0.4,"verified":true,"urgent":false,"day":{"year":2026,"month":11,"dayOfMonth":24},"takenAt":{"epochSecond":1795521600,"nano":0},"photo":{"uri":"https://example.com/p.jpg"},"contact":"a@example.com","quality":"high","unit":"imperial","tags":["t1"],"samples":[1,2],"serials":[7,8],"weights":[0.5,1.5],"flags":[true,false],"days":[{"year":2026,"month":11,"dayOfMonth":1}],"links":[{"uri":"https://example.com/l"}]}'
for want in t1 limit=5 serial=9000000000 temperature=18.5 verified=true unit=imperial day=2026-11-24 takenAt=2026 photo=https://example.com/p.jpg visited=2026-11-01 link=https://example.com/l; do
  run com.example.fieldnotes "$fsvc#logReading" "$all" "$want" quiet
done
run com.example.fieldnotes "$fsvc#logReading" "$all" 'r-1'
run com.example.fieldnotes "$fsvc#getReading" '{"readingId":"r-7"}' 'r-7'
run com.example.fieldnotes "$fsvc#syncNow" '{}' '{}'

exit $status
