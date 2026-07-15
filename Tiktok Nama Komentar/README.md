# TikTok Nama Komentar v1.1.2

Extension pribadi: ambil **nickname** komentator TikTok → **Copy** ke Excel (1 baris ke bawah).

Clean-room (bukan rebrand ToolMagic).

## Install

1. `chrome://extensions` → Developer mode  
2. **Load unpacked** → folder ini  
3. Buka **1 video** (`/video/...`)  
4. Buka panel **komentar** (badge API siap)  
5. **Proses** → **Copy nama** → paste Excel  

## Fitur

- Capture API `comment/list` + pagination cursor  
- Hanya nickname (bukan @username)  
- Panel + popup, opsi balasan  
- Tanpa paywall / login pihak ketiga  

## Tes

```powershell
powershell -File tests\run-tests.ps1
```
