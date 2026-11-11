"""Conservative validation of already parsed rehearsal journal histories.

The returned old paths are only observed references, not a complete inventory or
permission to remove anything. In particular paired new-bundle lacks new paths.
"""
import posixpath
import re


_OP = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z')
_SHA = re.compile(r'[a-f0-9]{40}\Z')
_DIGEST = re.compile(r'[a-f0-9]{64}\Z')


def _path(value):
    if (not isinstance(value, str) or not value.startswith('/') or value.startswith('//')
            or '\x00' in value or value == '/' or posixpath.normpath(value) != value):
        raise ValueError('invalid recorded path')
    return value


def _pair(row):
    pair = row.get('oldPair')
    if not isinstance(pair, dict):
        raise ValueError('missing old pair')
    return (_path(pair.get('cmsPath')), _path(pair.get('staticPath')))


_PAIR_DIGESTS = ('cmsPayloadSha256', 'staticTreeSha256', 'cmsDatabaseSha256',
                 'cmsMediaManifestSha256', 'cmsCaptureBundleSha256',
                 'oldDatabaseSha256', 'oldMediaManifestSha256', 'configSha256')
_RESTORE_DIGESTS = ('databaseSha256', 'staticTreeSha256', 'mediaManifestSha256', 'mediaStateSha256')


def _digest(value):
    return isinstance(value, str) and _DIGEST.fullmatch(value) is not None


def _validate_bundle(pair, sha):
    if (not isinstance(pair, dict) or any(pair.get(key) != sha for key in ('sourceSha', 'cmsSha', 'staticSha'))
            or not all(_digest(pair.get(key)) for key in _PAIR_DIGESTS)
            or not isinstance(pair.get('snapshotId'), str) or not pair['snapshotId'].startswith('snap:')):
        raise ValueError('invalid paired bundle evidence')
    proof = pair.get('cmsDatabaseProof')
    if (not isinstance(proof, dict) or type(proof.get('pid')) is not int or proof['pid'] <= 0
            or type(proof.get('device')) is not int or proof['device'] < 0
            or type(proof.get('inode')) is not int or proof['inode'] <= 0):
        raise ValueError('invalid CMS database proof')
    _path(proof.get('database'))


def _validate_restore(row):
    fingerprint = row.get('fingerprint')
    if (not all(_digest(row.get(key)) for key in _RESTORE_DIGESTS)
            or not isinstance(fingerprint, str) or not fingerprint.startswith('sha256:')
            or not _digest(fingerprint[7:])):
        raise ValueError('invalid staged restore evidence')
    return tuple(row[key] for key in (*_RESTORE_DIGESTS, 'fingerprint'))


def _audit_text(value, maximum):
    return (isinstance(value, str) and value == value.strip() and bool(value)
            and len(value) <= maximum and not any(ord(c) < 32 or ord(c) == 127 for c in value))


def validate_journal_history(rows):
    """Return observed old paths for complete histories; never determine deletion eligibility."""
    if not isinstance(rows, list):
        raise ValueError('invalid history')
    states = {}
    refs = set()
    for row in rows:
        if not isinstance(row, dict) or type(row.get('version')) is not int or row['version'] != 1:
            raise ValueError('invalid row')
        op, sha, record = row.get('operationId'), row.get('sourceSha'), row.get('record')
        if (not isinstance(op, str) or not _OP.fullmatch(op) or not isinstance(sha, str)
                or not _SHA.fullmatch(sha) or not isinstance(record, str)):
            raise ValueError('invalid operation identity')
        if record in ('start', 'static-main-start'):
            if op in states:
                raise ValueError('duplicate start')
            if record == 'start':
                old = _pair(row)
                refs.update(old)
                states[op] = {'kind': 'paired', 'phase': 'start', 'sha': sha, 'cms': old[0],
                              'old_static_digest': row['oldPair'].get('staticTreeSha256')}
            else:
                if row.get('operationKind') != 'static-main':
                    raise ValueError('invalid operation kind')
                old = _path(row.get('oldStaticPath'))
                digest = row.get('oldStaticTreeSha256')
                if not isinstance(digest, str) or not _DIGEST.fullmatch(digest):
                    raise ValueError('invalid old static digest')
                refs.add(old)
                states[op] = {'kind': 'static', 'phase': 'start', 'sha': sha,
                              'old': old, 'old_digest': row.get('oldStaticTreeSha256')}
            continue
        state = states.get(op)
        if state is None or state['sha'] != sha:
            raise ValueError('missing or conflicting start')
        phase = state['phase']
        if state['kind'] == 'paired':
            if record == 'fenced-baseline' and phase == 'start' and not state.get('baseline'):
                old = _pair(row)
                if old[0] != state['cms']:
                    raise ValueError('baseline changed CMS')
                refs.update(old)
                state['baseline'] = True
                state['old_static_digest'] = row['oldPair'].get('staticTreeSha256')
            elif record == 'new-bundle' and phase == 'start':
                _validate_bundle(row.get('newPair'), sha)
                state['phase'] = 'bundle'
            elif record == 'restore-prepared' and phase in ('start', 'bundle', 'restoring'):
                evidence = _validate_restore(row)
                if (not _digest(state.get('old_static_digest'))
                        or row['staticTreeSha256'] != state['old_static_digest']):
                    raise ValueError('staged restore static digest differs from effective old pair')
                if state.get('restore_evidence', evidence) != evidence:
                    raise ValueError('staged restore evidence changed')
                state.update(phase='restoring', restore_evidence=evidence)
            elif record == 'committed' and phase == 'bundle':
                state['phase'] = 'committed'
            elif record == 'recovered' and phase in ('start', 'bundle', 'restoring'):
                state['phase'] = 'recovered'
            else:
                raise ValueError('invalid paired sequence')
            continue
        if row.get('operationKind') != 'static-main':
            raise ValueError('invalid static operation kind')
        if record == 'static-main-prepared' and phase == 'start':
            digest, snapshot = row.get('staticTreeSha256'), row.get('snapshotId')
            if (not isinstance(digest, str) or not _DIGEST.fullmatch(digest)
                    or not isinstance(snapshot, str) or not snapshot.startswith('snap:')):
                raise ValueError('invalid prepared static evidence')
            state.update(phase='prepared', digest=digest, snapshot=snapshot)
        elif record == 'static-main-switch-intent' and phase == 'prepared':
            if _path(row.get('oldStaticPath')) != state['old'] or row.get('staticTreeSha256') != state['digest']:
                raise ValueError('conflicting static intent')
            state.update(phase='intent', candidate=_path(row.get('candidateStaticPath')))
        elif record == 'static-main-switched' and phase == 'intent' and row.get('staticTreeSha256') == state['digest']:
            state['phase'] = 'switched'
        elif (record == 'static-main-committed' and phase == 'switched'
              and row.get('staticTreeSha256') == state['digest'] and row.get('snapshotId') == state['snapshot']):
            state['phase'] = 'committed'
        elif record == 'static-main-rollback-expired' and phase == 'committed':
            if (_path(row.get('oldStaticPath')) != state['old']
                    or row.get('oldStaticTreeSha256') != state['old_digest']
                    or _path(row.get('candidateStaticPath')) != state.get('candidate')
                    or row.get('candidateStaticTreeSha256') != state['digest']
                    or row.get('committedStaticTreeSha256') != state['digest']
                    or row.get('snapshotId') != state['snapshot']
                    or row.get('targetState') != 'absent'
                    or not _audit_text(row.get('operator'), 120)
                    or not _audit_text(row.get('reason'), 1000)):
                raise ValueError('conflicting expired rollback evidence')
            state['phase'] = 'rollback-expired'
        elif record == 'static-main-rolled-back' and phase in ('intent', 'switched'):
            if _path(row.get('restoredStaticPath')) != state['old']:
                raise ValueError('conflicting restored target')
            state['phase'] = 'rolled-back'
        elif record == 'static-main-recovered' and phase in ('start', 'prepared', 'intent', 'switched', 'rolled-back'):
            if _path(row.get('restoredStaticPath')) != state['old']:
                raise ValueError('conflicting restored target')
            state['phase'] = 'recovered'
        elif record in ('static-main-rollback-intent', 'static-main-rollback-completed'):
            expected = 'committed' if record.endswith('intent') else 'rollback-intent'
            if (phase != expected or _path(row.get('oldStaticPath')) != state['old']
                    or _path(row.get('candidateStaticPath')) != state['candidate']
                    or row.get('oldStaticTreeSha256') != state['old_digest']
                    or row.get('candidateStaticTreeSha256') != state['digest']
                    or row.get('committedStaticTreeSha256') != state['digest']
                    or row.get('snapshotId') != state['snapshot']):
                raise ValueError('conflicting committed rollback')
            operator, reason = row.get('operator'), row.get('reason')
            if not _audit_text(operator, 120) or not _audit_text(reason, 1000):
                raise ValueError('invalid rollback operator or reason')
            if record.endswith('intent'):
                state['rollback_audit'] = (operator, reason)
            elif state.get('rollback_audit') != (operator, reason):
                raise ValueError('rollback audit changed')
            if record.endswith('completed') and _path(row.get('restoredStaticPath')) != state['old']:
                raise ValueError('conflicting restored target')
            state['phase'] = 'rollback-intent' if record.endswith('intent') else 'rollback-completed'
        else:
            raise ValueError('invalid static sequence')
    for state in states.values():
        if state['phase'] not in ('committed', 'recovered', 'rolled-back', 'rollback-completed', 'rollback-expired'):
            raise ValueError('incomplete operation')
    return refs
