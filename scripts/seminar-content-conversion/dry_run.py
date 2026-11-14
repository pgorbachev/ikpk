"""Write an offline proposal for supplied JSON records; never reads or modifies a DB."""
import argparse
import json
from pathlib import Path
from converter import convert, fingerprint


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('input', type=Path, help='JSON array of {source, sidecar} entries')
    parser.add_argument('output', type=Path, help='new private JSON report (never overwritten)')
    args = parser.parse_args()
    entries = json.loads(args.input.read_text(encoding='utf-8'))
    if not isinstance(entries, list) or any(not isinstance(x, dict) or 'source' not in x for x in entries):
        parser.error('input must be an array of {source, sidecar} entries')
    results = [{'identity': {k: entry['source'].get(k) for k in ('id', 'document_id', 'locale', 'version', 'path')},
                'result': convert(entry['source'], entry.get('sidecar'))} for entry in entries]
    report = {'input_sha256': fingerprint(entries), 'records': results,
              'notice': 'Proposal only. No record is approved for database application.'}
    with args.output.open('x', encoding='utf-8') as output:
        json.dump(report, output, ensure_ascii=False, indent=2)
        output.write('\n')


if __name__ == '__main__':
    main()
