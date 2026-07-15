# FB Nama Komentar v1.4.1

Ambil **nama tampilan** komentator Facebook → **Copy** ke Excel.

## UI di post

Ikon **kecil (orang)** di bar **Like · Komentar · Bagikan** — tidak mengubah layout FB.

| Aksi | Efek |
|------|------|
| **Klik ikon** | Proses ambil nama |
| **Klik lagi** (ada badge angka) | Copy nama ke clipboard |
| **Klik kanan** | Buka/tutup panel detail |
| **Popup extension** | Kontrol penuh |

## Mesin

GraphQL pagination aktif (capture request + cursor) + fallback DOM. Output **nama saja**.

## Install

1. Load unpacked folder ini / reload extension  
2. Hard refresh post (`Ctrl+F5`)  
3. Buka komentar → klik ikon N di bar aksi post  

## Debug

```js
window.__FNK__.version
window.__FNK__.templates()
window.__FNK__.scrape()
```
