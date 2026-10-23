import os
import pytest
from PIL import Image
from testfn.visual import VisualTester

def test_visual_comparison():
    tester = VisualTester(baseline_dir="test_baselines", diff_dir="test_diffs")
    
    # Create dummy images
    img1 = Image.new("RGB", (100, 100), color="red")
    img1_path = "img1.png"
    img1.save(img1_path)
    
    img2 = Image.new("RGB", (100, 100), color="blue")
    img2_path = "img2.png"
    img2.save(img2_path)
    
    # First time: saves as baseline
    passed, score, diff_path = tester.compare_screenshots(img1_path, "dummy")
    assert passed is True
    assert score == 0.0
    assert os.path.exists("test_baselines/dummy.png")
    
    # Second time: compare with baseline (different)
    passed, score, diff_path = tester.compare_screenshots(img2_path, "dummy")
    assert passed is False
    assert score > 0.1
    assert diff_path is not None
    assert os.path.exists(diff_path)
    
    # Cleanup
    for p in [img1_path, img2_path, "test_baselines/dummy.png", diff_path]:
        if p and os.path.exists(p):
            os.remove(p)
    if os.path.exists("test_baselines"):
        os.rmdir("test_baselines")
    if os.path.exists("test_diffs"):
        os.rmdir("test_diffs")
