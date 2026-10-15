from io import BytesIO
from pathlib import Path

import pytest
from PIL import Image

from browsefn.core.errors import BrowseFnError
from browsefn.core.types import ImageDownloadOptions, ImageResult, ImageSource, ImageDownloads
from browsefn.images._transform import transform_image
from browsefn.images._selection import ImageSelection
from browsefn.images.providers.unsplash import UnsplashProvider


def solid(width, height, color):
    output = BytesIO()
    Image.new('RGBA', (width, height), color).save(output, format='PNG')
    return output.getvalue()


@pytest.mark.asyncio
@pytest.mark.parametrize('format', ['jpeg', 'png', 'webp'])
async def test_formats_resize_and_metadata(format):
    data, metadata = await transform_image(solid(100, 50, 'red'), ImageDownloadOptions(format=format, maxWidth=40))
    with Image.open(BytesIO(data)) as decoded:
        assert decoded.format.lower() == format
        assert decoded.size == (40, 20)
    assert (metadata.width, metadata.height, metadata.size) == (40, 20, len(data))


@pytest.mark.asyncio
async def test_crop_then_resize_pixels():
    image = Image.new('RGB', (40, 20), 'red')
    image.paste(Image.new('RGB', (20, 20), 'blue'), (20, 0))
    output = BytesIO()
    image.save(output, format='PNG')
    data, _ = await transform_image(output.getvalue(), ImageDownloadOptions(crop={'x': 20, 'y': 0, 'width': 20, 'height': 20}, maxWidth=10))
    with Image.open(BytesIO(data)) as decoded:
        assert decoded.size == (10, 10)
        assert decoded.convert('RGB').getpixel((0, 0)) == (0, 0, 255)


@pytest.mark.asyncio
async def test_quality_changes_real_encoded_output():
    image = Image.frombytes('RGB', (64, 64), bytes((index * 73 + index // 7) % 256 for index in range(64 * 64 * 3)))
    output = BytesIO()
    image.save(output, format='PNG')
    low, _ = await transform_image(output.getvalue(), ImageDownloadOptions(format='jpeg', quality=5))
    high, _ = await transform_image(output.getvalue(), ImageDownloadOptions(format='jpeg', quality=95))
    assert len(low) < len(high)
    assert Image.open(BytesIO(low)).format == 'JPEG'


@pytest.mark.asyncio
async def test_watermark_position_opacity_and_text(tmp_path):
    mark = tmp_path / 'mark.png'
    mark.write_bytes(solid(2, 2, 'white'))
    data, _ = await transform_image(solid(8, 8, 'black'), ImageDownloadOptions(watermark={'image': str(mark), 'position': 'top-left', 'opacity': 0.5}))
    with Image.open(BytesIO(data)) as decoded:
        assert decoded.getpixel((0, 0))[0] in (127, 128)
        assert decoded.getpixel((7, 0))[0] == 0
    for opacity in (0, 1):
        data, _ = await transform_image(solid(160, 60, 'black'), ImageDownloadOptions(watermark={'text': 'A<&', 'opacity': opacity, 'position': 'center'}))
        with Image.open(BytesIO(data)) as decoded:
            assert bool(max(decoded.convert('RGB').getextrema()[0])) == bool(opacity)


@pytest.mark.asyncio
async def test_direct_size_and_original():
    content = solid(1000, 500, 'red')
    _, metadata = await transform_image(content, ImageDownloadOptions(size='small'))
    assert (metadata.width, metadata.height) == (640, 320)
    original, _ = await transform_image(content, ImageDownloadOptions(size='original'))
    assert original == content


@pytest.mark.asyncio
async def test_invalid_inputs_and_private_watermark():
    for content, options in [(b'invalid', {}), (solid(10, 10, 'red'), {'crop': {'x': 9, 'y': 0, 'width': 2, 'height': 2}})]:
        with pytest.raises(BrowseFnError):
            await transform_image(content, ImageDownloadOptions(**options))
    with pytest.raises(BrowseFnError) as error:
        await transform_image(solid(10, 10, 'red'), ImageDownloadOptions(watermark={'image': 'http://127.0.0.1/secret'}))
    assert error.value.code == 'SECURITY_POLICY_BLOCKED'


def test_provider_size_selection():
    image = ImageResult(id='1', url='https://example.com/default', thumbnail='', width=10, height=10,
                        source=ImageSource(provider='test', url='https://example.com/page'),
                        downloads=ImageDownloads(small='https://example.com/small', original='https://example.com/raw'))
    selection = ImageSelection()
    url, options = selection.resolve(image, ImageDownloadOptions(size='small'))
    assert url == image.downloads.small and options.size is None
    with pytest.raises(BrowseFnError, match="no large download URL"):
        selection.resolve(image, ImageDownloadOptions(size="large"))
    selection.remember([image])
    assert selection.resolve(image.source.url, ImageDownloadOptions(size='original'))[0] == image.downloads.original


@pytest.mark.asyncio
async def test_provider_download_transforms_real_bytes(tmp_path, monkeypatch):
    async def transfer(_url, _options):
        return solid(100, 50, 'red')
    monkeypatch.setattr('browsefn.images.providers._shared.fetch_image_bytes', transfer)
    result = await UnsplashProvider().download('https://example.com/a.png', ImageDownloadOptions(destination=str(tmp_path), format='webp', maxWidth=40))
    assert result.success and result.format == 'webp'
    with Image.open(result.path) as decoded:
        assert decoded.format == 'WEBP' and decoded.size == (40, 20)
    assert Path(result.path).suffix == '.webp'
