# ICOM CI-V Profile Notes

This project transports CI-V frames inside ICOM LAN/WLAN UDP CIV packets. The UDP session layer remains project-specific, but the payload commands are aligned with Hamlib's ICOM backend.

## Hamlib Sources Used

- `Hamlib/rigs/icom/icom_defs.h` for CI-V command/subcommand constants.
- `Hamlib/rigs/icom/frame.c` for standard `FE FE [rig] [controller] cmd ... FD` framing.
- `Hamlib/rigs/icom/icom.c` for frequency, mode, PTT, tuner, meter, level and spectrum behavior.
- `Hamlib/rigs/icom/ic7300.c`, `ic7610.c`, and `ic7760.c` for modern model private capabilities and calibration tables.

## Key Corrections

| Area | Previous behavior | Hamlib-aligned behavior | Main source |
| --- | --- | --- | --- |
| 0x14 MIC gain | `0x14 0x0f` | `0x14 0x0b`; `0x0f` is BK-IN delay | `icom_defs.h` `S_LVL_MICGAIN`, `S_LVL_BKINDL` |
| 0x14 NR level | `0x14 0x13` | `0x14 0x06`; `0x13` is DIGI/DIGI-SEL extension | `icom_defs.h` `S_LVL_NR`, `S_LVL_DIGI` |
| Mode setting | `0x06 [mode] 0x01` | Modern profiles use `0x26 [vfo] [mode] [dataMode] [filter]` | `icom.c`, modern model caps with `mode_with_filter` |
| Frequency setting | Always `0x05` + 5-byte BCD | Modern profiles use `0x25 [vfo] [freqBCD]`; legacy fallback keeps `0x05` | `icom.c` targetable frequency handling |
| IC-905 high frequency | No 10 GHz support | Uses 6-byte little-endian frequency BCD above 5.85 GHz | IC-905 logic in Hamlib ICOM backend |
| TX frequency | Single parser searched for command bytes | `0x1c 0x03` is parsed from a fixed payload offset | `icom_defs.h` `S_RD_TX_FREQ` |
| PTT status | Non-standard `0x1a 0x00 0x48` compatibility path | Standard public read uses `0x1c 0x00` | `icom_defs.h` `C_CTL_PTT`, `S_PTT` |
| Tuner | Guessed `0x1a` family | `0x1c 0x01`, payload `0/1/2` for off/on/start tune | `icom_defs.h` `S_ANT_TUN`, `icom.c` |
| Spectrum span | Encoded public span directly | Encodes `spanHz / 2`, decodes by multiplying by 2 | `icom.c` `RIG_LEVEL_SPECTRUM_SPAN` |
| Scope ranges | One IC-705-like range table | Profile-specific range tables for IC-7300/9700/7610/705/905/7760 | model source files |
| Meters | Raw divide-by constants | Profile calibration interpolation for SWR, ALC, RF power, COMP, voltage/current | `icom.c`, `ic7300.c`, `ic7610.c`, `ic7760.c` |
| Connector WLAN level | Treated as general ICOM standard | Private vendor extension only when profile declares it | absent from Hamlib standard extcmds |

## A/B API Coverage Added

| Public area | Hamlib/CI-V source | Notes |
| --- | --- | --- |
| Generic function layer | `icom_set_func()` / `icom_get_func()` | `0x16` function family for NB, NR, COMP, VOX, TONE, TSQL, ANF, MON, manual notch, lock, APF/AFC/VSC where supported |
| BK-IN wrappers | `S_FUNC_BKIN = 0x47` | Semi break-in writes raw `1`, full break-in writes raw `2`, off writes raw `0` |
| RIT/XIT | `C_CTL_RIT = 0x21` | Offset uses `0x21 0x00` with little-endian BCD plus sign byte; enable flags use `0x21 0x01/0x02` |
| Generic level layer | `icom_set_level()` / `icom_get_level()` | Adds RF gain, IF shift, PBT in/out, CW pitch, key speed, notch, compressor, monitor gain, VOX gain, anti-VOX and profile ext levels |
| CW pitch / key speed | `cw_lookup` and `RIG_LEVEL_CWPITCH` logic in `icom.c` | CW pitch is exposed as 300..900 Hz; key speed is exposed as 6..48 WPM |
| Split / TX VFO | `icom_set_split_*()` and targetable `0x25/0x26` paths | Modern profiles use VFO number `1` for TX frequency/mode; split enable uses `0x0f 0x00/0x01` |
| VFO operations | `icom_vfo_op()` | Safe subset: copy, exchange, from VFO, to VFO, memory clear and tune |
| Tuning step | `ic7300_ts_sc_list`, `ic705_ts_sc_list`, `ic9700_ts_sc_list`, `ic756pro_ts_sc_list` | Step tables are profile data and writes use `0x10 [stepCode]` |
| Tone / repeater | `C_SET_TONE`, `C_CTL_SPLT`, `C_RD_OFFS`, `C_SET_OFFS` | CTCSS is public Hz encoded as tenth-Hz BCD BE; repeater offset is public Hz encoded as 100 Hz units |
| Parameters / extcmds | model `*_extcmds[]` tables | Adds BEEP, BACKLIGHT, SCREENSAVER, TIME, KEYERTYPE, AFIF/AFIF_WLAN/AFIF_LAN/AFIF_ACC, TRANSCEIVE, SPECTRUM_AVG and USB AF where profile declares them |
| Spectrum advanced | `icom_set_ext_level()`, `icom_get_ext_level()`, `S_SCP_*` constants | Adds data output, hold, speed, reference level, average, VBW/RBW, during-TX and center type controls |

Deferred items remain intentionally out of scope: marker position (`TOK_SCOPE_MKP` is listed by some profiles but has no concrete generic handler in the inspected Hamlib path), full scan/memory APIs, CW/voice memory, power state, clock, antenna selection and D-STAR/raw digital families.

## Profile Defaults

The first profile set covers `IC-705`, `IC-905`, `IC-7300`, `IC-9700`, `IC-7610`, `IC-7760`, plus `generic-modern-icom`. A user-provided `IcomRigOptions.model` wins over auto-detection; otherwise the active profile is resolved from rig name, then CI-V address, then generic fallback.

Vendor-only connector routing commands remain available only when a profile declares them. They are not treated as Hamlib-standard CI-V commands.
