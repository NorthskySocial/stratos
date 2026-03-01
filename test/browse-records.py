#!/usr/bin/env python3
"""
Dev-mode record browser for Stratos.

Lists records for a user and inspects individual records with boundary info.
Uses dev-mode auth (Bearer <DID>) — only works when STRATOS_DEV_MODE=true.

Usage:
    python browse-records.py                         # interactive mode
    python browse-records.py --list rei              # list rei's posts
    python browse-records.py --list rei --as sakura  # list rei's posts as sakura
    python browse-records.py --get <at-uri>          # get a specific record
    python browse-records.py --get <at-uri> --as rei # get record as rei
    python browse-records.py --discover <did>        # discover Stratos via ATProto pathway
"""

import argparse
import json
import os
import sys
import textwrap
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen
from urllib.error import HTTPError

CONFIG = {"url": "http://localhost:3100"}
DEFAULT_COLLECTION = "app.northsky.stratos.feed.post"

# Known test users — loaded from test-state.json if available, otherwise hardcoded fallbacks
KNOWN_USERS: dict[str, dict] = {}

# PDS URL cache: did → pds_url
PDS_CACHE: dict[str, str] = {}


class C:
    """ANSI color codes for terminal output."""
    PDS = "\033[36m"       # cyan — PDS content
    STRATOS = "\033[35m"   # magenta — Stratos content
    BOUNDARY = "\033[33m"  # yellow — boundary info
    HEAD = "\033[1m"       # bold — headers
    DIM = "\033[2m"        # dim — secondary info
    INFO = "\033[34m"      # blue — info messages
    ERR = "\033[31m"       # red — errors
    OK = "\033[32m"        # green — success
    R = "\033[0m"          # reset


def load_test_state():
    """Try to load test-state.json from the current working directory."""
    state_path = os.path.join(os.getcwd(), "test-state.json")
    try:
        with open(state_path) as f:
            state = json.load(f)
        for name, info in state.get("users", {}).items():
            KNOWN_USERS[name] = {
                "did": info["did"],
                "handle": info.get("handle", ""),
            }
    except (FileNotFoundError, json.JSONDecodeError):
        pass


def resolve_user(name_or_did: str) -> str:
    """Resolve a friendly name or DID to a DID string."""
    if name_or_did.startswith("did:"):
        return name_or_did
    if name_or_did in KNOWN_USERS:
        return KNOWN_USERS[name_or_did]["did"]
    print(f"Unknown user '{name_or_did}'. Known users: {', '.join(KNOWN_USERS.keys())}")
    sys.exit(1)


def friendly_name(did: str) -> str:
    """Return a friendly name for a DID if known."""
    for name, info in KNOWN_USERS.items():
        if info["did"] == did:
            return name
    return did


def xrpc_get(path: str, params: dict | None = None, caller_did: str | None = None):
    """Make an XRPC GET request. Returns (status, body_dict | error_text)."""
    url = f"{CONFIG['url']}/xrpc/{path}"
    if params:
        url += "?" + urlencode(params)
    headers = {}
    if caller_did:
        headers["Authorization"] = f"Bearer {caller_did}"
    req = Request(url, headers=headers)
    try:
        with urlopen(req) as resp:
            return resp.status, json.loads(resp.read())
    except HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        return e.code, body


def xrpc_post(path: str, body: dict, caller_did: str | None = None):
    """Make an XRPC POST request. Returns (status, body_dict | error_text)."""
    url = f"{CONFIG['url']}/xrpc/{path}"
    data = json.dumps(body).encode()
    headers = {"Content-Type": "application/json"}
    if caller_did:
        headers["Authorization"] = f"Bearer {caller_did}"
    req = Request(url, data=data, headers=headers, method="POST")
    try:
        with urlopen(req) as resp:
            return resp.status, json.loads(resp.read())
    except HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        return e.code, body


PLC_DIRECTORY = "https://plc.directory"


def http_get_json(url: str) -> tuple[int, dict | str]:
    """Simple GET returning (status, parsed_json | error_text)."""
    req = Request(url)
    try:
        with urlopen(req) as resp:
            return resp.status, json.loads(resp.read())
    except HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        return e.code, body


def resolve_did_document(did: str) -> dict | None:
    """Resolve a DID to its DID document via PLC directory or did:web."""
    if did.startswith("did:plc:"):
        status, body = http_get_json(f"{PLC_DIRECTORY}/{did}")
        if status == 200 and isinstance(body, dict):
            return body
        print(f"  ℹ  Could not resolve {did} via PLC directory (status {status})")
        return None
    elif did.startswith("did:web:"):
        host = did[8:].replace(":", "/")
        status, body = http_get_json(f"https://{host}/.well-known/did.json")
        if status == 200 and isinstance(body, dict):
            return body
        print(f"  ℹ  Could not resolve {did} via did:web (status {status})")
        return None
    else:
        print(f"  ℹ  Unsupported DID method: {did}")
        return None


def find_service_endpoint(did_doc: dict, fragment: str) -> str | None:
    """Find a service endpoint by fragment in a DID document."""
    for svc in did_doc.get("service", []):
        svc_id = svc.get("id", "")
        if svc_id == fragment or svc_id.endswith(fragment):
            return svc.get("serviceEndpoint")
    return None


def discover_pds(did: str) -> str | None:
    """Discover a user's PDS endpoint from their DID document."""
    doc = resolve_did_document(did)
    if not doc:
        return None
    pds = find_service_endpoint(doc, "#atproto_pds")
    if not pds:
        print(f"  ℹ  No #atproto_pds service in DID document for {did}")
    return pds


def discover_stratos_from_pds(did: str, pds_url: str) -> dict | None:
    """Read the enrollment record from the user's PDS to find the Stratos service."""
    params = urlencode({"repo": did, "collection": "app.northsky.stratos.actor.enrollment", "rkey": "self"})
    status, body = http_get_json(f"{pds_url}/xrpc/com.atproto.repo.getRecord?{params}")
    if status == 200 and isinstance(body, dict):
        return body.get("value", {})
    return None


def resolve_pds_url(did: str) -> str | None:
    """Resolve and cache the PDS URL for a DID."""
    if did in PDS_CACHE:
        return PDS_CACHE[did]
    pds = discover_pds(did)
    if pds:
        PDS_CACHE[did] = pds
    return pds


def pds_xrpc_get(pds_url: str, path: str, params: dict | None = None):
    """Make an XRPC GET request against a PDS (unauthenticated)."""
    url = f"{pds_url}/xrpc/{path}"
    if params:
        url += "?" + urlencode(params)
    req = Request(url)
    try:
        with urlopen(req) as resp:
            return resp.status, json.loads(resp.read())
    except HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        return e.code, body


def pds_list_records(did: str, collection: str, limit: int = 50) -> list[dict] | None:
    """List records from a user's PDS. Returns record list or None on failure."""
    pds_url = resolve_pds_url(did)
    if not pds_url:
        return None
    params = {"repo": did, "collection": collection, "limit": str(limit)}
    status, body = pds_xrpc_get(pds_url, "com.atproto.repo.listRecords", params)
    if status == 200 and isinstance(body, dict):
        return body.get("records", [])
    return None


def pds_get_record(did: str, collection: str, rkey: str) -> dict | None:
    """Get a single record from a user's PDS. Returns the full response or None."""
    pds_url = resolve_pds_url(did)
    if not pds_url:
        return None
    params = {"repo": did, "collection": collection, "rkey": rkey}
    status, body = pds_xrpc_get(pds_url, "com.atproto.repo.getRecord", params)
    if status == 200 and isinstance(body, dict):
        return body
    return None


def format_source_field(source: dict, indent: str = "      ") -> str:
    """Format the source field from a PDS stub record."""
    vary = source.get("vary", "?")
    subject = source.get("subject", {})
    service = source.get("service", "?")
    lines = [
        f"{indent}{C.DIM}vary:    {vary}{C.R}",
        f"{indent}{C.DIM}subject: {subject.get('uri', '?')}{C.R}",
        f"{indent}{C.DIM}cid:     {subject.get('cid', '?')}{C.R}",
        f"{indent}{C.DIM}service: {service}{C.R}",
    ]
    return "\n".join(lines)


def list_stratos_collections(did: str, stratos_url: str) -> list[str]:
    """List collections available on a Stratos service for a DID."""
    status, body = http_get_json(f"{stratos_url}/xrpc/com.atproto.repo.describeRepo?repo={quote(did)}")
    if status == 200 and isinstance(body, dict):
        return body.get("collections", [])
    return []


def cmd_discover(user: str):
    """Full ATProto discovery pathway: DID → PDS → enrollment record → Stratos → collections → records."""
    did = resolve_user(user)

    print(
        "",
        f"  {C.HEAD}ATProto Discovery{C.R}",
        f"  {C.DIM}─────────────────{C.R}",
        f"  DID: {did}",
        "",
        sep="\n",
    )

    # Step 1: Resolve DID document
    print(f"  {C.HEAD}[1/4]{C.R} Resolving DID document...")
    doc = resolve_did_document(did)
    if not doc:
        print(f"        {C.ERR}Failed to resolve DID document.{C.R}")
        return
    pds_url = find_service_endpoint(doc, "#atproto_pds")
    if pds_url:
        PDS_CACHE[did] = pds_url
    handle = None
    for aka in doc.get("alsoKnownAs", []):
        if aka.startswith("at://"):
            handle = aka[5:]
    print(
        f"        Handle: {handle or '(unknown)'}",
        f"        {C.PDS}PDS:    {pds_url or '(not found)'}{C.R}",
        sep="\n",
    )
    if not pds_url:
        return

    # Step 2: Read enrollment record from PDS
    print(f"\n  {C.HEAD}[2/4]{C.R} Reading enrollment record from {C.PDS}PDS{C.R}...")
    enrollment = discover_stratos_from_pds(did, pds_url)
    if not enrollment:
        print(
            f"        {C.INFO}No app.northsky.stratos.actor.enrollment record found.{C.R}",
            f"        {C.INFO}This user is not enrolled in any Stratos service.{C.R}",
            sep="\n",
        )
        return
    stratos_url = enrollment.get("service", "")
    enrollment_boundaries = enrollment.get("boundaries", [])
    boundary_names = [b.get("value", "?") for b in enrollment_boundaries]
    print(
        f"        {C.STRATOS}Stratos service: {stratos_url}{C.R}",
        f"        {C.BOUNDARY}Boundaries:      {', '.join(boundary_names) if boundary_names else '(none)'}{C.R}",
        f"        Enrolled at:     {enrollment.get('createdAt', '?')}",
        sep="\n",
    )
    if not stratos_url:
        print(f"        {C.INFO}ℹ  Enrollment record has no service URL.{C.R}")
        return

    # Step 3: Discover collections on Stratos
    print(f"\n  {C.HEAD}[3/4]{C.R} Querying {C.STRATOS}Stratos{C.R} for collections...")
    collections = list_stratos_collections(did, stratos_url)
    if collections:
        for c in collections:
            print(f"        • {c}")
    else:
        print("        (no collections found)")

    # Step 4: List records from each collection (both PDS and Stratos)
    print(f"\n  {C.HEAD}[4/4]{C.R} Listing records ({C.PDS}PDS{C.R} + {C.STRATOS}Stratos{C.R})...")
    if not collections:
        print("        (nothing to list)")
        return

    saved_url = CONFIG["url"]
    CONFIG["url"] = stratos_url
    try:
        for collection in collections:
            # Stratos records
            params = {"repo": did, "collection": collection, "limit": "10"}
            status, body = xrpc_get("com.atproto.repo.listRecords", params)
            stratos_recs = body.get("records", []) if status == 200 else []

            # PDS records
            pds_recs = pds_list_records(did, collection, 10) or []

            total = max(len(stratos_recs), len(pds_recs))
            print(f"\n        {C.HEAD}{collection}{C.R} ({total} record{'s' if total != 1 else ''})")

            # Index by rkey
            s_by_rkey: dict[str, dict] = {}
            for rec in stratos_recs:
                try:
                    _, _, rk = parse_at_uri(rec["uri"])
                    s_by_rkey[rk] = rec
                except (ValueError, KeyError):
                    pass
            p_by_rkey: dict[str, dict] = {}
            for rec in pds_recs:
                try:
                    _, _, rk = parse_at_uri(rec["uri"])
                    p_by_rkey[rk] = rec
                except (ValueError, KeyError):
                    pass

            all_rkeys: list[str] = []
            seen: set[str] = set()
            for rec in stratos_recs + pds_recs:
                try:
                    _, _, rk = parse_at_uri(rec["uri"])
                    if rk not in seen:
                        all_rkeys.append(rk)
                        seen.add(rk)
                except (ValueError, KeyError):
                    pass

            for i, rk in enumerate(all_rkeys, 1):
                s_rec = s_by_rkey.get(rk)
                p_rec = p_by_rkey.get(rk)
                uri = (s_rec or p_rec or {}).get("uri", f"at://{did}/{collection}/{rk}")
                print(f"          [{i}] {uri}")

                if p_rec:
                    p_val = p_rec.get("value", {})
                    source = p_val.get("source")
                    if source:
                        print(f"              {C.PDS}PDS: stub → service: {source.get('service', '?')}{C.R}")
                    else:
                        print(f"              {C.PDS}PDS: full record (no source){C.R}")
                else:
                    print(f"              {C.DIM}PDS: not found{C.R}")

                if s_rec:
                    s_val = s_rec.get("value", {})
                    boundaries = format_boundaries(s_val)
                    text = s_val.get("text", "")
                    print(f"              {C.STRATOS}Stratos: {C.BOUNDARY}{boundaries}{C.R}")
                    if text:
                        wrapped = textwrap.fill(text, width=56, initial_indent="              ", subsequent_indent="              ")
                        print(f"{C.STRATOS}{wrapped}{C.R}")
                else:
                    print(f"              {C.DIM}Stratos: not visible{C.R}")

            cursor = body.get("cursor") if status == 200 else None
            if cursor:
                print(f"          {C.DIM}(more available — cursor: {cursor}){C.R}")
    finally:
        CONFIG["url"] = saved_url

    print()


def parse_at_uri(uri: str) -> tuple[str, str, str]:
    """Parse at://did/collection/rkey into (did, collection, rkey)."""
    if not uri.startswith("at://"):
        raise ValueError(f"Not an AT-URI: {uri}")
    parts = uri[5:].split("/")
    if len(parts) < 3:
        raise ValueError(f"Incomplete AT-URI (need did/collection/rkey): {uri}")
    return parts[0], parts[1], "/".join(parts[2:])


def format_record(value: dict, indent: int = 2) -> str:
    """Pretty-format a record value."""
    return json.dumps(value, indent=indent, ensure_ascii=False)


def format_boundaries(value: dict) -> str:
    """Extract and format boundary info from a record value."""
    boundary = value.get("boundary", {})
    values = boundary.get("values", [])
    if not values:
        return "(no boundaries — visible to all enrolled users)"
    domains = [v.get("value", "?") for v in values]
    return ", ".join(domains)


def cmd_list(repo: str, collection: str, caller_did: str | None, limit: int = 50):
    """List records for a user — shows both PDS stubs and Stratos full records."""
    repo_did = resolve_user(repo)
    viewer = friendly_name(caller_did) if caller_did else "unauthenticated"

    print(
        "",
        f"  {C.HEAD}Records in {collection}{C.R}",
        f"  Repo:   {friendly_name(repo_did)} ({repo_did})",
        f"  Viewer: {viewer}" + (f" ({caller_did})" if caller_did and not caller_did.startswith("did:") else ""),
        "",
        sep="\n",
    )

    # Fetch from Stratos
    params = {"repo": repo_did, "collection": collection, "limit": str(limit)}
    stratos_status, stratos_body = xrpc_get("com.atproto.repo.listRecords", params, caller_did)
    stratos_records = stratos_body.get("records", []) if stratos_status == 200 else []

    # Fetch from PDS
    pds_records = pds_list_records(repo_did, collection, limit)

    # Index PDS records by rkey for side-by-side comparison
    pds_by_rkey: dict[str, dict] = {}
    if pds_records:
        for rec in pds_records:
            try:
                _, _, rkey = parse_at_uri(rec["uri"])
                pds_by_rkey[rkey] = rec
            except (ValueError, KeyError):
                pass

    pds_url = PDS_CACHE.get(repo_did, "?")

    if not stratos_records and not pds_records:
        print("  (no records visible)")
        return

    # Collect all rkeys in order (Stratos first, then PDS-only)
    seen_rkeys: set[str] = set()
    all_rkeys: list[str] = []
    for rec in stratos_records:
        try:
            _, _, rkey = parse_at_uri(rec["uri"])
            if rkey not in seen_rkeys:
                all_rkeys.append(rkey)
                seen_rkeys.add(rkey)
        except (ValueError, KeyError):
            pass
    if pds_records:
        for rec in pds_records:
            try:
                _, _, rkey = parse_at_uri(rec["uri"])
                if rkey not in seen_rkeys:
                    all_rkeys.append(rkey)
                    seen_rkeys.add(rkey)
            except (ValueError, KeyError):
                pass

    # Index Stratos records by rkey
    stratos_by_rkey: dict[str, dict] = {}
    for rec in stratos_records:
        try:
            _, _, rkey = parse_at_uri(rec["uri"])
            stratos_by_rkey[rkey] = rec
        except (ValueError, KeyError):
            pass

    for i, rkey in enumerate(all_rkeys, 1):
        s_rec = stratos_by_rkey.get(rkey)
        p_rec = pds_by_rkey.get(rkey)
        uri = (s_rec or p_rec or {}).get("uri", f"at://{repo_did}/{collection}/{rkey}")

        print(f"  {C.HEAD}[{i}]{C.R} {uri}")

        if p_rec:
            p_val = p_rec.get("value", {})
            source = p_val.get("source")
            print(f"      {C.PDS}PDS ({pds_url}){C.R}")
            if source:
                print(f"      {C.PDS}stub record → source:{C.R}")
                print(format_source_field(source))
            else:
                print(f"      {C.PDS}record (no source field — not a stub){C.R}")
                text = p_val.get("text", "")
                if text:
                    wrapped = textwrap.fill(text, width=72, initial_indent="      ", subsequent_indent="      ")
                    print(f"{C.PDS}{wrapped}{C.R}")
        else:
            print(f"      {C.DIM}PDS: (not fetched or not found){C.R}")

        if s_rec:
            s_val = s_rec.get("value", {})
            boundaries = format_boundaries(s_val)
            text = s_val.get("text", "")
            print(f"      {C.STRATOS}Stratos ({CONFIG['url']}){C.R}")
            print(f"      {C.BOUNDARY}boundaries: {boundaries}{C.R}")
            if text:
                wrapped = textwrap.fill(text, width=72, initial_indent="      ", subsequent_indent="      ")
                print(f"{C.STRATOS}{wrapped}{C.R}")
        else:
            print(f"      {C.DIM}Stratos: (not visible — may be boundary-restricted){C.R}")

        print()

    stratos_cursor = stratos_body.get("cursor") if stratos_status == 200 else None
    if stratos_cursor:
        print(f"  {C.DIM}(more records available — cursor: {stratos_cursor}){C.R}")
    print(f"  {C.DIM}Shown: {len(all_rkeys)} record(s) — {C.STRATOS}Stratos: {len(stratos_records)}{C.R}{C.DIM}, {C.PDS}PDS: {len(pds_records) if pds_records is not None else '?'}{C.R}")


def cmd_get(uri: str, caller_did: str | None):
    """Get a specific record — shows both PDS stub and Stratos full record."""
    try:
        repo_did, collection, rkey = parse_at_uri(uri)
    except ValueError as e:
        print(f"  {C.ERR}Error: {e}{C.R}")
        return

    viewer = friendly_name(caller_did) if caller_did else "unauthenticated"
    print(
        "",
        f"  {C.HEAD}Fetching record{C.R}",
        f"  URI:    {uri}",
        f"  Repo:   {friendly_name(repo_did)} ({repo_did})",
        f"  Viewer: {viewer}",
        "",
        sep="\n",
    )

    # Fetch from PDS
    pds_rec = pds_get_record(repo_did, collection, rkey)
    pds_url = PDS_CACHE.get(repo_did, "?")

    print(f"  {C.PDS}── PDS ({pds_url}) ──{C.R}")
    if pds_rec:
        p_val = pds_rec.get("value", {})
        source = p_val.get("source")
        print(f"  {C.PDS}CID: {pds_rec.get('cid', '?')}{C.R}")
        if source:
            print(f"  {C.PDS}Stub record with source field:{C.R}")
            print(format_source_field(source, indent="  "))
            created = p_val.get("createdAt", "")
            if created:
                print(f"  {C.DIM}createdAt: {created}{C.R}")
        else:
            record_lines = "\n".join(f"    {C.PDS}{line}{C.R}" for line in format_record(p_val).splitlines())
            print(f"  {C.PDS}Full record (no source — not a stub):{C.R}", record_lines, sep="\n")
    else:
        print(f"  {C.DIM}(not found on PDS or PDS not reachable){C.R}")
    print()

    # Fetch from Stratos
    print(f"  {C.STRATOS}── Stratos ({CONFIG['url']}) ──{C.R}")
    status, body = xrpc_get(
        "com.atproto.repo.getRecord",
        {"repo": repo_did, "collection": collection, "rkey": rkey},
        caller_did,
    )

    if status == 200:
        value = body.get("value", {})
        cid = body.get("cid", "?")
        boundaries = format_boundaries(value)
        record_lines = "\n".join(f"    {C.STRATOS}{line}{C.R}" for line in format_record(value).splitlines())
        print(
            f"  {C.STRATOS}CID: {cid}{C.R}",
            f"  {C.BOUNDARY}Boundaries: {boundaries}{C.R}",
            f"  {C.STRATOS}Full record:{C.R}",
            record_lines,
            "",
            sep="\n",
        )
    elif status == 400:
        try:
            err = json.loads(body) if isinstance(body, str) else body
        except json.JSONDecodeError:
            err = {"message": body}

        error_name = err.get("error", "Unknown")

        if error_name == "RecordNotFound":
            # Stratos returns the same error for missing and boundary-restricted records to preserve privacy
            print(
                f"  {C.INFO}ℹ  Record not accessible{C.R}",
                f"  {C.INFO}   The record may not exist, or viewer '{viewer}' may lack{C.R}",
                f"  {C.INFO}   boundary access to this record.{C.R}",
                "",
                sep="\n",
            )
        else:
            message = err.get("message", str(body))
            print(f"  {C.INFO}ℹ  {error_name}: {message}{C.R}", "", sep="\n")
    else:
        print(f"  {C.ERR}Error {status}: {body}{C.R}", "", sep="\n")


def cmd_hydrate(uri: str, caller_did: str | None):
    """Hydrate a record via the Stratos-specific endpoint — shows blocked status explicitly."""
    try:
        parse_at_uri(uri)
    except ValueError as e:
        print(f"  {C.ERR}Error: {e}{C.R}")
        return

    viewer = friendly_name(caller_did) if caller_did else "unauthenticated"
    print(
        "",
        f"  {C.HEAD}Hydrating record{C.R}",
        f"  URI:    {uri}",
        f"  Viewer: {viewer}",
        "",
        sep="\n",
    )

    status, body = xrpc_post(
        "app.northsky.stratos.repo.hydrateRecords",
        {"uris": [uri]},
        caller_did,
    )

    if status != 200:
        print(f"  {C.ERR}Error {status}: {body}{C.R}")
        return

    records = body.get("records", [])
    not_found = body.get("notFound", [])
    blocked = body.get("blocked", [])

    if records:
        rec = records[0]
        value = rec.get("value", {})
        boundaries = format_boundaries(value)
        record_lines = "\n".join(f"    {C.STRATOS}{line}{C.R}" for line in format_record(value).splitlines())
        print(
            f"  {C.STRATOS}CID:        {rec.get('cid', '?')}{C.R}",
            f"  {C.BOUNDARY}Boundaries: {boundaries}{C.R}",
            "",
            f"  {C.STRATOS}Record value:{C.R}",
            record_lines,
            "",
            sep="\n",
        )
    elif blocked:
        print(
            f"  {C.INFO}ℹ  Boundary restriction{C.R}",
            f"  {C.INFO}   Viewer '{viewer}' does not share a boundary with this record.{C.R}",
            f"  {C.INFO}   The record exists but is not accessible to this viewer.{C.R}",
            "",
            sep="\n",
        )
    elif not_found:
        print(f"  {C.INFO}ℹ  Record not found: {uri}{C.R}", "", sep="\n")
    else:
        print(f"  {C.INFO}ℹ  Unexpected empty response{C.R}", "", sep="\n")


def cmd_interactive():
    """Interactive browsing mode."""
    print(
        "",
        f"  {C.HEAD}Stratos Record Browser (dev mode){C.R}",
        f"  {C.DIM}──────────────────────────────────{C.R}",
        f"  {C.PDS}cyan = PDS{C.R}  {C.STRATOS}magenta = Stratos{C.R}  {C.BOUNDARY}yellow = boundaries{C.R}",
        sep="\n",
    )

    if KNOWN_USERS:
        print("\n  Known users:")
        for name, info in KNOWN_USERS.items():
            print(f"    {name:12s} {info['did']}")
    print()

    viewer_did: str | None = None

    while True:
        try:
            prompt = f"  [{friendly_name(viewer_did) if viewer_did else 'no auth'}] > "
            line = input(prompt).strip()
        except (EOFError, KeyboardInterrupt):
            print("\n  bye!")
            break

        if not line:
            continue

        parts = line.split()
        cmd = parts[0].lower()

        if cmd in ("quit", "exit", "q"):
            print("  bye!")
            break

        elif cmd == "help":
            print("""
  Commands:
    auth <user>           Set viewer identity (name or DID, 'none' to clear)
    list <user> [coll]    List records for user (default collection: app.northsky.stratos.feed.post)
    get <at-uri>          Fetch a specific record via getRecord
    hydrate <at-uri>      Fetch via hydrateRecords (shows blocked status explicitly)
    discover <user>       Discover Stratos via ATProto pathway (DID → PDS → enrollment → records)
    users                 Show known users
    help                  Show this help
    quit                  Exit
""")

        elif cmd == "auth":
            if len(parts) < 2:
                print(f"  Current viewer: {friendly_name(viewer_did) if viewer_did else 'none'}")
                continue
            who = parts[1]
            if who == "none":
                viewer_did = None
                print("  Cleared auth — now unauthenticated")
            else:
                viewer_did = resolve_user(who) if not who.startswith("did:") else who
                print(f"  Viewer set to {friendly_name(viewer_did)} ({viewer_did})")

        elif cmd == "users":
            if KNOWN_USERS:
                for name, info in KNOWN_USERS.items():
                    print(f"    {name:12s} {info['did']}")
            else:
                print("  No known users (test-state.json not found)")

        elif cmd == "list":
            if len(parts) < 2:
                print("  Usage: list <user> [collection]")
                continue
            user = parts[1]
            collection = parts[2] if len(parts) > 2 else DEFAULT_COLLECTION
            cmd_list(user, collection, viewer_did)

        elif cmd == "get":
            if len(parts) < 2:
                print("  Usage: get <at-uri>")
                continue
            cmd_get(parts[1], viewer_did)

        elif cmd == "hydrate":
            if len(parts) < 2:
                print("  Usage: hydrate <at-uri>")
                continue
            cmd_hydrate(parts[1], viewer_did)

        elif cmd == "discover":
            if len(parts) < 2:
                print("  Usage: discover <user>")
                continue
            cmd_discover(parts[1])

        else:
            print(f"  Unknown command: {cmd} (type 'help' for commands)")


def main():
    load_test_state()

    parser = argparse.ArgumentParser(
        description="Stratos dev-mode record browser",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=textwrap.dedent("""\
            examples:
              %(prog)s                                    interactive mode
              %(prog)s --list rei                         list rei's posts
              %(prog)s --list rei --as sakura             list rei's posts as sakura
              %(prog)s --list rei --as kaoruko            list rei's posts as kaoruko (different boundary)
              %(prog)s --get at://did:.../collection/rkey get a specific record
              %(prog)s --hydrate at://did:.../coll/rkey   hydrate (shows blocked vs not-found)
              %(prog)s --discover rei                     discover Stratos via ATProto pathway
        """),
    )
    parser.add_argument("--url", default=CONFIG["url"], help="Stratos service URL")
    parser.add_argument("--list", metavar="USER", help="List records for a user (name or DID)")
    parser.add_argument("--collection", default=DEFAULT_COLLECTION, help="Collection NSID")
    parser.add_argument("--get", metavar="AT_URI", help="Get a specific record by AT-URI")
    parser.add_argument("--hydrate", metavar="AT_URI", help="Hydrate a record (shows blocked status)")
    parser.add_argument("--discover", metavar="USER", help="Discover Stratos via ATProto (DID → PDS → enrollment → records)")
    parser.add_argument("--as", dest="viewer", metavar="USER", help="Authenticate as this user (name or DID)")
    parser.add_argument("--limit", type=int, default=50, help="Max records to return")

    args = parser.parse_args()

    CONFIG["url"] = args.url

    caller_did = resolve_user(args.viewer) if args.viewer else None

    if args.discover:
        cmd_discover(args.discover)
    elif args.list:
        cmd_list(args.list, args.collection, caller_did, args.limit)
    elif args.get:
        cmd_get(args.get, caller_did)
    elif args.hydrate:
        cmd_hydrate(args.hydrate, caller_did)
    else:
        cmd_interactive()


if __name__ == "__main__":
    main()
