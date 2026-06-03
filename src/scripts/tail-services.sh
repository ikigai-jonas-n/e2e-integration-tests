#!/usr/bin/env bash
# src/scripts/tail-services.sh
# Intelligently splits the screen into a readable GRID (max 3 columns).
# Features a Dead-Man's Switch: Pressing Ctrl+C in ANY pane instantly closes the entire grid.

LOG_DIR="logs/latest"
SPLIT_MODE=true

if [[ "${1:-}" == "--no-split" ]]; then
  SPLIT_MODE=false
fi

if [ ! -d "$LOG_DIR" ]; then
  echo "❌ No logs found. Run 'bun test' first."
  exit 1
fi

# Load active log files safely
# shellcheck disable=SC2207
FILES=($(find -L "$LOG_DIR" -maxdepth 1 -type f -name "*.log" ! -name "_*" ! -name "docker-*" ! -name "test_*"))
N=${#FILES[@]}

if [ $N -eq 0 ]; then
  echo "⏳ No Node logs found yet. Services might still be booting..."
  exit 1
fi

if [ "$SPLIT_MODE" = false ]; then
  echo "📡 Streaming combined logs..."
  tail -F "${FILES[@]}"
  exit 0
fi

echo "🪟 Calculating optimal Grid Layout (Max 3 columns)..."

# --- GRID MATH ---
MAX_COLS=3
COLS=$(( N < MAX_COLS ? N : MAX_COLS ))

# Distribute files evenly into column arrays
for ((c=0; c<COLS; c++)); do
  eval "COL_$c=()"
done

for ((i=0; i<N; i++)); do
  c=$(( i % COLS ))
  eval "COL_$c+=(\"${FILES[i]}\")"
done

# --- DEAD-MAN'S SWITCH (Cross-Pane Kill Signal) ---
export PARENT_PID=$$
LOCK_FILE="/tmp/e2e_logs_kill_$PARENT_PID.lock"
touch "$LOCK_FILE"
WINDOW_IDS=()

# The master cleanup function
cleanup() {
  rm -f "$LOCK_FILE" >/dev/null 2>&1
  
  if [[ "$TERM_PROGRAM" == "iTerm.app" ]]; then
    osascript -e "tell application \"iTerm\" to repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if name of s contains \"E2E_CHILD_$PARENT_PID\" then close s
        end repeat
      end repeat
    end repeat" >/dev/null 2>&1
  elif [[ "$TERM" == *"kitty"* ]]; then
    for wid in "${WINDOW_IDS[@]}"; do
      kitty @ close-window --match id:"$wid" >/dev/null 2>&1
    done
  fi
  exit 0
}
trap cleanup INT TERM

# Watcher: if any pane deletes the lock file, immediately trigger cleanup
(
  while [ -f "$LOCK_FILE" ]; do sleep 0.3; done
  kill -INT $PARENT_PID 2>/dev/null
) &


# ==========================================
# 1. iTerm2 (Native AppleScript Grid)
# ==========================================
if [[ "$TERM_PROGRAM" == "iTerm.app" ]]; then
  echo "🍏 Building native iTerm2 grid..."
  
  SCRIPT="tell application \"iTerm\"
    tell current window
      tell current tab
        set col_0_0 to current session
  "
  
  for ((c=1; c<COLS; c++)); do
    prev=$((c-1))
    SCRIPT+="set col_${c}_0 to split col_${prev}_0 vertically with default profile
    "
  done

  for ((c=0; c<COLS; c++)); do
    eval "col_len=\${#COL_$c[@]}"
    for ((r=0; r<col_len; r++)); do
      eval "FILE_R=\"\${COL_$c[$r]}\""
      NAME_R=$(basename "$FILE_R")
      
      # Set ANSI title so AppleScript can find it, run tail, and delete lockfile on Ctrl+C
      CHILD_CMD="echo -ne '\\033]0;E2E_CHILD_$PARENT_PID\\007'; clear; echo '📡 Tailing: $NAME_R'; tail -F '$(pwd)/$FILE_R'; rm -f '$LOCK_FILE'"
      
      if [ "$c" -eq 0 ] && [ "$r" -eq 0 ]; then
        continue # Main pane is handled in the foreground below
      elif [ "$r" -eq 0 ]; then
        SCRIPT+="write col_${c}_0 text \"$CHILD_CMD\"
        "
      else
        prev_r=$((r-1))
        SCRIPT+="set col_${c}_${r} to split col_${c}_${prev_r} horizontally with default profile
        write col_${c}_${r} text \"$CHILD_CMD\"
        "
      fi
    done
  done
  SCRIPT+="
      end tell
    end tell
  end tell"
  
  osascript -e "$SCRIPT" >/dev/null 2>&1

  # Block the main pane. Pressing Ctrl+C here safely triggers the trap.
  echo -ne "\033]0;E2E_CHILD_$PARENT_PID\007"
  echo -e "\033c📡 Tailing: $(basename "${FILES[0]}")"
  tail -F "${FILES[0]}"
  
  # If tail naturally exits or Ctrl+C is pressed, delete lock and cleanup
  rm -f "$LOCK_FILE"
  cleanup

# ==========================================
# 2. Kitty (Native Kitty Remote Grid)
# ==========================================
elif [[ "$TERM" == *"kitty"* ]]; then
  echo "🐱 Building native Kitty grid..."
  
  if ! kitty @ ls >/dev/null 2>&1; then
    echo "❌ Kitty remote control is disabled."
    echo "   Fix: Add 'allow_remote_control yes' to your kitty.conf and restart kitty."
    exit 1
  fi
  
  for ((i=1; i<N; i++)); do
    FILE_I="${FILES[i]}"
    NAME_I=$(basename "$FILE_I")
    CHILD_CMD="echo '📡 Tailing: $NAME_I'; tail -F '$(pwd)/$FILE_I'; rm -f '$LOCK_FILE'"
    
    WID=$(kitty @ launch --type=window --title="E2E_CHILD_$PARENT_PID" --cwd="$(pwd)" sh -c "$CHILD_CMD")
    WINDOW_IDS+=("$WID")
  done
  
  kitty @ goto-layout grid >/dev/null 2>&1
  
  echo -e "\033c📡 Tailing: $(basename "${FILES[0]}")"
  tail -F "${FILES[0]}"
  
  rm -f "$LOCK_FILE"
  cleanup

# ==========================================
# 3. Ghostty / Alacritty / VS Code (Zellij Grid)
# ==========================================
else
  if ! command -v zellij >/dev/null 2>&1; then
    echo "⚙️  Auto-installing 'Zellij' for grid layout..."
    if command -v brew >/dev/null 2>&1; then
      brew install zellij
    else
      echo "❌ Homebrew not found. Please run: bash <(curl -L zellij.dev/launch)"
      exit 1
    fi
  fi

  echo "🌀 Launching Zellij auto-grid..."
  
  LAYOUT_FILE="/tmp/e2e_layout_$PARENT_PID.kdl"
  echo "layout {" > "$LAYOUT_FILE"
  echo "    pane split_direction=\"vertical\" {" >> "$LAYOUT_FILE"
  
  # Build columns
  for ((c=0; c<COLS; c++)); do
      echo "        pane split_direction=\"horizontal\" {" >> "$LAYOUT_FILE"
      eval "col_len=\${#COL_$c[@]}"
      
      for ((r=0; r<col_len; r++)); do
          eval "FILE=\"\${COL_$c[$r]}\""
          NAME=$(basename "$FILE")
          echo "            pane {" >> "$LAYOUT_FILE"
          echo "                command \"tail\"" >> "$LAYOUT_FILE"
          echo "                args \"-F\" \"$(pwd)/$FILE\"" >> "$LAYOUT_FILE"
          echo "                name \"$NAME\"" >> "$LAYOUT_FILE"
          echo "            }" >> "$LAYOUT_FILE"
      done
      
      echo "        }" >> "$LAYOUT_FILE"
  done
  
  echo "    }" >> "$LAYOUT_FILE"
  echo "}" >> "$LAYOUT_FILE"  # <-- FIX: CLOSE THE LAYOUT NODE HERE!
  
  # ── MAGIC: INSTANT QUIT ON CTRL+C ──
  # Appended safely at the root level of the file
  echo "keybinds {" >> "$LAYOUT_FILE"
  echo "    shared_except \"locked\" {" >> "$LAYOUT_FILE"
  echo "        bind \"Ctrl c\" { Quit; }" >> "$LAYOUT_FILE"
  echo "    }" >> "$LAYOUT_FILE"
  echo "}" >> "$LAYOUT_FILE"
  
  zellij --layout "$LAYOUT_FILE"
  
  rm -f "$LAYOUT_FILE" "$LOCK_FILE"
  exit 0
fi