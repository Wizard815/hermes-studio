#!/bin/sh
# A Studio chat waiting in herdr (one per chat whose agent is not running).
# Shows the chat, tells herdr it is the chat's idle agent, and resumes the
# agent right here on Enter. Kept to plain sh so hundreds of chats stay cheap.
#
#   studio-chat.sh <chat id>
#
# Studio sets: STUDIO_CHAT_DIR (chat cards), STUDIO_CHAT_KIND (herdr agent kind,
# empty when herdr cannot run this chat's agent), STUDIO_CHAT_AGENT (the agent
# name herdr lists), STUDIO_CHAT_URL (the chat in Studio), STUDIO_NODE,
# STUDIO_PLUGIN and STUDIO_PLUGIN_CONFIG_DIR (Studio's herdr plugin).
id="$1"
script="$0"
herdr="${HERDR_BIN_PATH:-herdr}"
card="${STUDIO_CHAT_DIR}/${id}.txt"
agent="${STUDIO_CHAT_AGENT:-$STUDIO_CHAT_KIND}"

show() {
  printf '\033[2J\033[H'
  if [ -r "$card" ]; then cat "$card"; else printf '  Studio chat %s\n' "$id"; fi
  printf '\n'
  if [ -n "$STUDIO_CHAT_KIND" ]; then
    printf '  \033[1mPress Enter\033[0m to continue this chat here.\n'
  else
    printf '  \033[1mPress Enter\033[0m to talk to this chat here (it runs in Studio: %s).\n' "${STUDIO_CHAT_URL:-open it in Studio}"
  fi
}

report() {
  # herdr may still be starting (after a restart): try until it answers.
  tries=0
  while [ "$tries" -lt 15 ]; do
    "$herdr" pane report-agent "$HERDR_PANE_ID" --source studio:chat --agent "$agent" --state idle -- \
      env "STUDIO_CHAT_DIR=$STUDIO_CHAT_DIR" "STUDIO_CHAT_KIND=$STUDIO_CHAT_KIND" "STUDIO_CHAT_AGENT=$agent" \
      "STUDIO_CHAT_URL=$STUDIO_CHAT_URL" "STUDIO_NODE=$STUDIO_NODE" "STUDIO_PLUGIN=$STUDIO_PLUGIN" \
      "STUDIO_PLUGIN_CONFIG_DIR=$STUDIO_PLUGIN_CONFIG_DIR" sh "$script" "$id" >/dev/null 2>&1 && return 0
    tries=$((tries + 1))
    sleep 1
  done
}

while :; do
  show
  # herdr lists this pane as the chat's agent, idle, until it resumes. After a
  # herdr restart, herdr starts this same waiting pane again (the command after --).
  watch=''
  if [ -n "$agent" ] && [ -n "$HERDR_PANE_ID" ]; then
    report
    # herdr can drop the report while it is still restoring panes: check again
    # for a short while (stopped as soon as the chat resumes).
    ( for wait in 2 3 5 10 10; do
        sleep "$wait"
        "$herdr" pane get "$HERDR_PANE_ID" 2>/dev/null | grep -q '"agent":"' || report
      done ) &
    watch=$!
  fi
  read -r _ || { [ -n "$watch" ] && kill "$watch" 2>/dev/null; exit 0; }
  [ -n "$watch" ] && kill "$watch" 2>/dev/null
  if [ -z "$STUDIO_CHAT_KIND" ]; then
    # herdr cannot run this agent (Ekko, Hermes without its CLI): talk to it through Studio.
    if ! STUDIO_CHAT_SCRIPT="$script" "${STUDIO_NODE:-node}" "$STUDIO_PLUGIN" chat "$id"; then
      printf '\n  Press Enter to go back to the chat.\n'
      read -r _ || exit 0
    fi
    continue
  fi
  # Hand the pane back to herdr's own agent detection, then run the agent here.
  [ -n "$HERDR_PANE_ID" ] && "$herdr" pane release-agent "$HERDR_PANE_ID" --source studio:chat --agent "$agent" >/dev/null 2>&1
  if ! "${STUDIO_NODE:-node}" "$STUDIO_PLUGIN" resume "$id"; then
    # Keep the error on screen until it has been read.
    printf '\n  Press Enter to go back to the chat.\n'
    read -r _ || exit 0
  fi
  # The agent exited: the chat waits here again.
done
