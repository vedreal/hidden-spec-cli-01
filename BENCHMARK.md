# Benchmark lokal — mend (hidden-spec-cli-01-run-20261122)

Diukur 2026-11-22 ~23:30 WIB di VM ini (Node v24.22.1), dengan kit
`hidden-spec-cli-01-run-20261122-kit`, perintah `node check.ts
<kit>/program/generator/practice.json`.

## Practice set (100 check publik, hasil yang diharapkan dari referensi)

| Grup | Lolos |
| --- | --- |
| unified | 30 / 30 |
| search-replace | 20 / 20 |
| v4a | 20 / 20 |
| json | 15 / 15 |
| cli | 15 / 15 |
| **Total** | **100 / 100 — practice score 1000** |

## Baseline house (strict applier)

House memasukkan strict applier sebagai baseline; sebuah reward butuh
skor di atasnya. Baseline diukur di sini dengan menjalankan practice
set yang sama lewat `main.ts --strict` (tier 0 saja, penanganan format
sama) — script `/tmp/bench-strict.mjs`:

| Grup | Strict |
| --- | --- |
| unified | 24 / 30 |
| search-replace | 11 / 20 |
| v4a | 11 / 20 |
| json | 15 / 15 |
| cli | 12 / 15 |
| **Total** | **73 / 100 — practice score 730** |

`mend` (1000) mengalahkan baseline itu sekitar **270 poin** di practice
set. Kegagalan strict terkonsentrasi di check yang butuh pencocokan
tier 1/2 (trailing whitespace, indentasi) — tepat yang SPEC minta
diatasi.

## Fuzz / kasus tepi sendiri (`tests/fuzz.json`)

44 kasus yang ditulis tangan dari kalimat-kalimat SPEC.md yang tidak
ditunjukkan practice set, dijalankan dengan `node check.ts
tests/fuzz.json`: **44 / 44 lolos** (practice score 1000 pada set itu).

Yang diuji antara lain: pair `---`/`+++` sesudah hunk pertama
(section baru), section tanpa hunk, `diff --git` yang tidak sesuai
bentuk, hunk O kosong di A=0 dan di A=99 (sisip di akhir), move ke path
yang sudah ada (`exists`), section kedua memakai file yang dibuat
section pertama, garis `\` sesudah baris `-` (final break tetap),
file CRLF, file tanpa trailing newline, baris body `---- foo`,
`---` di header tanpa `+++`, hunk sebelum section, patch hanya prosa,
dua hunk dengan offset `d`, S/R tanpa path, path di atas fence
`` ``` ``, S/R mewarisi path block sebelumnya, S/R tier-2 re-indent,
S/R membuat file di subdirektori baru dan file kosong, V4A move-only,
anchor V4A di tier 2, chunk end-of-file dengan dua kemunculan, Update
tanpa chunk dan tanpa Move to, Move to sesudah chunk, chunk `@@`
kosong, Add File dengan baris kosong di tengah, anchor V4A yang
muncul dua kali, JSON array dengan create, str_replace dengan
kemunculan yang tumpang tindih (`ambiguous`), insert di baris 0 dan di
akhir, JSON array dengan edit yang salah, JSONL dengan baris kosong,
`--check` (tidak menulis), `--strict` yang butuh tier 1, `--check`
ganda (`usage`), satu edit gagal + satu berhasil (atomik: tidak ada
file yang ditulis), path `unsafe`, patch kosong, patch yang tidak ada,
pemisah `--`, move dengan file lama yang hilang.

Satu hal yang sempat salah di ekspektasi fuzz, bukan di implementasi:
patch yang hanya berisi hunk (tanpa `diff --git` / pair `---`+`+++`)
menjawab `error: format`, bukan `error: parse 1`, karena aturan
deteksi format SPEC §4 didahulukan; kalimat "hunk sebelum section =
parse error" berlaku bila formatnya sudah terdeteksi unified (hunk
dulu, pair kemudian) — kasus itu juga ada di fuzz dan lolos.
