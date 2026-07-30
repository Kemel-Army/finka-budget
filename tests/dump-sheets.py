# -*- coding: utf-8 -*-
"""Выгружает листы исходных Excel в JSON — массив массивов, как это делает
   XLSX.utils.sheet_to_json(ws, {header: 1, defval: '', blankrows: true}) в
   браузере после расширения диапазона до A1.

   Важно: строки нумеруются от первой строки листа, а не от первой заполненной.
   Именно на это опираются конвертеры импорта, считающие по номерам строк.

   Нужен, чтобы прогнать конвертеры импорта на настоящих файлах:
       python tests/dump-sheets.py
"""
import openpyxl, io, json, glob, os, datetime

try:
    import xlrd  # старые .xls
except ImportError:
    xlrd = None

HERE = os.path.dirname(__file__)
# Исходные книги лежат отдельной папкой, чтобы не мешаться в корне
BOOKS = os.path.join(HERE, "..", "excel")
OUT = os.path.join(HERE, "sheets.json")
result = {}


def clean(v):
    if v is None:
        return ""
    # cellDates: true в браузере отдаёт Date — здесь пишем ISO-строку
    if isinstance(v, (datetime.datetime, datetime.date)):
        return v.isoformat()
    if isinstance(v, datetime.time):
        return v.isoformat()
    return v


def trim(rows):
    # хвостовые пустые строки Excel не отдаёт
    while rows and all(v == "" for v in rows[-1]):
        rows.pop()
    return rows


def put(path, sheet_name, rows):
    """Одно и то же имя листа встречается в разных книгах: «План командир
    2026» есть и в книге-заготовке, и в рабочей книге с настоящими числами;
    «План по видам Алматы» — сразу в двух справках. Поэтому лист всегда
    кладётся под полным ключом «Лист [книга]», а короткое имя занимает первая
    книга по алфавиту: так набор фикстур не разъезжается, когда рядом
    появляется ещё один файл."""
    rows = trim(rows)
    book = os.path.splitext(os.path.basename(path))[0]
    result[sheet_name + " [" + book + "]"] = rows
    result.setdefault(sheet_name, rows)


for path in sorted(glob.glob(os.path.join(BOOKS, "*.xlsx"))):
    if "Алгоритм" in path:
        continue
    wb = openpyxl.load_workbook(path, data_only=True)
    for ws in wb.worksheets:
        put(path, ws.title, [
            [clean(v) for v in row] for row in ws.iter_rows(values_only=True)
        ])
    wb.close()

if xlrd:
    for path in sorted(glob.glob(os.path.join(BOOKS, "*.xls"))):
        wb = xlrd.open_workbook(path)
        for ws in wb.sheets():
            put(path, ws.name, [
                [clean(ws.cell_value(r, c)) for c in range(ws.ncols)]
                for r in range(ws.nrows)
            ])

with io.open(OUT, "w", encoding="utf-8") as f:
    json.dump(result, f, ensure_ascii=False)

print("листов выгружено:", len(result))
