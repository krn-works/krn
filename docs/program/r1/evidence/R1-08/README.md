# R1-08 acceptance evidence
`acceptance.txt` records the measured head, source/test tree SHAs, rg readback, and host gate result.
`paperclip-mapping-readback.json` records the LON-217 task description readback.
The tree SHAs bind the acceptance evidence to the code if evidence files change the repository head.
Verify with `git rev-parse HEAD:src` and `git rev-parse HEAD:test`.
