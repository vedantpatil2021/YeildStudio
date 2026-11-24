"""Runs one Studio script with the real earthengine-api, in its own process (started by ee_runner.py).

Reads {"code", "project", "start": <export description or null>} as JSON on stdin and writes one JSON result on
stdout. Inside the script, as in the Code Editor:
  Map.addLayer(obj, vis, name)  -> a map-tile URL from getMapId
  Map.centerObject / setCenter  -> where the map should go
  print(...)                    -> console lines; Earth Engine objects are fetched with getInfo()
  ee.batch.Export.*.*(...)      -> recorded as a task (not started). With "start", the export whose description
                                   matches is started and its Earth Engine task id is returned.
ee.Initialize(...) in the script is ignored: everything runs under the lab's project and credentials.
"""
import json
import sys
import traceback

MAX_LOG = 200          # console entries kept per run
MAX_TEXT = 20000       # characters per printed value
MARKER = "__YIELD_STUDIO_RESULT__"


def main():
    req = json.loads(sys.stdin.read())
    out = {"logs": [], "layers": [], "center": None, "exports": [], "started": None}

    def log(entry):
        if len(out["logs"]) < MAX_LOG:
            out["logs"].append(entry)

    try:
        import os
        import ee
        key = os.environ.get("EE_SERVICE_ACCOUNT_FILE")
        if key:
            with open(key) as f:
                credentials = ee.ServiceAccountCredentials(json.load(f)["client_email"], key)
            ee.Initialize(credentials, project=req["project"])
        else:
            ee.Initialize(project=req["project"])
    except Exception as e:      # credentials, project or quota problems
        out["error"] = f"Earth Engine is not available: {e}"
        emit(out)
        return

    def plain(v):
        if isinstance(v, ee.ComputedObject):
            v = v.getInfo()
        return v

    class MapShim:
        @staticmethod
        def addLayer(obj, vis=None, name=None, shown=True, opacity=1):
            vis = dict(vis or {})
            if isinstance(obj, (ee.Geometry, ee.Feature)):
                obj = ee.FeatureCollection([obj])
            if isinstance(obj, ee.FeatureCollection):
                obj = obj.style(**{"color": vis.pop("color", "000000"), "fillColor": "00000000", "width": 1})
            elif isinstance(obj, ee.ImageCollection):
                obj = obj.mosaic()
            for k in ("palette", "bands"):     # the API wants comma-separated strings
                if isinstance(vis.get(k), (list, tuple)):
                    vis[k] = ",".join(map(str, vis[k]))
            m = ee.Image(obj).getMapId(vis)
            out["layers"].append({"name": name or f"Layer {len(out['layers']) + 1}", "url": m["tile_fetcher"].url_format,
                                  "visible": bool(shown), "opacity": float(opacity)})

        @staticmethod
        def centerObject(obj, zoom=None):
            geom = obj if isinstance(obj, ee.Geometry) else obj.geometry()
            ring = geom.bounds(1).coordinates().getInfo()[0]
            lons, lats = [p[0] for p in ring], [p[1] for p in ring]
            out["center"] = {"bounds": [[min(lats), min(lons)], [max(lats), max(lons)]], "zoom": zoom}

        @staticmethod
        def setCenter(lon, lat, zoom=None):
            out["center"] = {"lat": lat, "lon": lon, "zoom": zoom}

    def print_(*args, **_):
        values = [plain(a) for a in args]
        if len(values) == 2 and isinstance(values[0], str) and isinstance(values[1], (dict, list)):
            log({"type": "object", "label": values[0], "value": values[1]})
        elif len(values) == 2 and isinstance(values[0], str) and isinstance(values[1], (int, float, str, bool)):
            log({"type": "text", "text": values[0], "value": values[1]})
        else:
            log({"type": "text", "text": " ".join(v if isinstance(v, str) else json.dumps(v, default=str) for v in values)[:MAX_TEXT]})

    def wrap(group, kind, fn):
        def export(*args, **kwargs):
            task = fn(*args, **kwargs)
            desc = kwargs.get("description") or (task.config or {}).get("description") or f"{group}_{kind}"
            params = {k: v for k, v in kwargs.items() if isinstance(v, (str, int, float, bool)) or v is None}
            out["exports"].append({"description": desc, "export_type": f"{group}.{kind}", "params": params})
            if req.get("start") == desc and out["started"] is None:
                task.start()
                out["started"] = task.id
            return task
        return export

    for group in ("image", "table", "video", "map"):
        holder = getattr(ee.batch.Export, group, None)
        for kind in [k for k in dir(holder) if k.startswith("to")] if holder else []:
            setattr(holder, kind, staticmethod(wrap(group, kind, getattr(holder, kind))))

    ee.Initialize = lambda *a, **k: None
    env = {"ee": ee, "Map": MapShim, "print": print_, "__name__": "__main__"}
    try:
        exec(compile(req["code"], "<script>", "exec"), env)
    except Exception as e:
        tb = traceback.extract_tb(e.__traceback__)
        line = next((f.lineno for f in reversed(tb) if f.filename == "<script>"), None)
        out["error"] = f"{type(e).__name__}: {e}" + (f" (line {line})" if line else "")
    emit(out)


def emit(out):
    """The result is the last stdout line, after a marker, so stray library output cannot corrupt it."""
    sys.stdout.write("\n" + MARKER + json.dumps(out, default=str) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
