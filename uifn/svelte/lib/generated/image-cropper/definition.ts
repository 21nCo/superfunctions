import { createImageCropperController, type ImageCropperProps } from '@uifn/core/primitives/image-cropper';
import type { SveltePrimitiveDefinition } from '../../internal/compound.js';
import { createUIFnRangeGestureAdapterBinding } from '@uifn/dom';

export const ImageCropperDefinition: SveltePrimitiveDefinition<ImageCropperProps> = {
  name: 'ImageCropper',
  family: 'range-gesture',
  kind: 'interactive-controller',
  rootPart: 'root',
  inputNames: ["src","crop","defaultCrop","aspectRatio","minSize","maxSize","disabled"],
  contextKey: Symbol('uifn.ImageCropper'),
  createController: createImageCropperController as never,
  domBindings: [/* @__PURE__ */ createUIFnRangeGestureAdapterBinding({"parts":["cropArea"],"entries":["handle"]})],
};
