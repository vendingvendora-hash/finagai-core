# ADR-058: Mac tasks return their final image to the chat and iMessage

- Status: Accepted (Julian, principal, 2026-10-02)
- Date: 2026-10-02

## Problem
A chat could read a task's text result but not its visual output; a chart/screenshot built on the Mac had
nowhere to go but a vague promise. Julian wants one request to finish autonomously and hand back the image.

## Decision
- A finished J6 task stores result_image_b64 (migration 0015): the final screenshot of the turn where the
  agent declared done, capped to a safe size.
- control_result now returns that image as an MCP image content block, so it renders directly in the chat.
- The Mac helper also sends the final image to Julian's iMessage thread on completion (and offers to
  forward it to a requesting contact). So the artifact lands in BOTH places.

## Limit stated honestly
A connector cannot post into a chat unprompted — the chat must call control_result to pull the result.
What this delivers is one-shot completion: ask once, Finagai does the whole task, the chat shows the image
when it reads the result, and iMessage gets it automatically.

## Unchanged
All approval gates; reads free; send/pay/delete/run still need Julian's ok.
