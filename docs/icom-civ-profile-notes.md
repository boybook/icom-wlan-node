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

## Profile Defaults

The first profile set covers `IC-705`, `IC-905`, `IC-7300`, `IC-9700`, `IC-7610`, `IC-7760`, plus `generic-modern-icom`. A user-provided `IcomRigOptions.model` wins over auto-detection; otherwise the active profile is resolved from rig name, then CI-V address, then generic fallback.

Vendor-only connector routing commands remain available only when a profile declares them. They are not treated as Hamlib-standard CI-V commands.
