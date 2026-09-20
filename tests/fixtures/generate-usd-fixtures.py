"""Rebuild tiny synthetic parser fixtures with Pixar's independent usd-core writer.

Developer utility only; not a runtime or test-suite dependency.
Run with USD_WRITE_NEW_USDC_FILES_AS_VERSION=0.8.0 and usd-core installed.
"""
from pathlib import Path
from pxr import Sdf

here = Path(__file__).resolve().parent
source = (here / "usd-room-scan.usda").read_text()


def write(name, change=None):
    layer = Sdf.Layer.CreateAnonymous("fixture.usda")
    assert layer.ImportFromString(source)
    if change:
        change(layer)
    assert layer.Export(str(here / name))


write("usd-room-scan.usd")
write("usd-no-units.usd", lambda layer: layer.pseudoRoot.ClearInfo("metersPerUnit"))


def add_reference(layer):
    layer.GetPrimAtPath("/SyntheticScan").referenceList.prependedItems = [Sdf.Reference("not-present.usd")]


write("usd-composed-scan.usd", add_reference)
write("usd-unsupported-geometry.usd", lambda layer: Sdf.PrimSpec(layer.GetPrimAtPath("/SyntheticScan"), "Unmeshed", Sdf.SpecifierDef, "Cube"))


def subdivision(layer, value):
    attribute = layer.GetAttributeAtPath("/SyntheticScan/Mesh_grp/Arch_grp/Wall0.subdivisionScheme")
    if value is None:
        attribute.owner.RemoveProperty(attribute)
    else:
        attribute.default = value


write("usd-subdivided.usd", lambda layer: subdivision(layer, "catmullClark"))
write("usd-default-subdivision.usd", lambda layer: subdivision(layer, None))
