# Handwriting recogniser — training

The model at `public/hwr/` recognises single handwritten characters
(EMNIST digits + letters, plus synthetic `+ - = ( ) . , /`). It is a
small MLP run in the browser with TensorFlow.js, loaded lazily the first
time a student opens the "Write" pad.

## Retrain

```
mkdir train && cd train
npm init -y
npm i @tensorflow/tfjs@4.22.0 @tensorflow/tfjs-backend-wasm@4.22.0
# EMNIST "balanced" idx files into ./gzip/  (from the NIST EMNIST gzip.zip)
#   emnist-balanced-{train,test}-{images-idx3,labels-idx1}-ubyte
cp ../train.mjs ../quant.mjs .
node train.mjs          # writes ./out/  (best epoch by val_acc)
node quant.mjs ./out ./out-q   # uint8-quantise: 2.7MB -> 665KB
cp out-q/model.json out-q/weights.bin ../../public/hwr/
```

`lib/handwriting.js` (`rasterGlyph`, `segment`, `norm28`-equivalent) must
stay byte-for-byte consistent with the preprocessing in `train.mjs` —
train / test / inference all feed the model the same 28×28 normalisation
(ink cropped, longest side → 20px, max-pooled downscale, centre-of-mass
placement clamped to the frame). `HWR_CHARS` must match `CHARS` in
`train.mjs`.

Current model: ~86% per-character on the EMNIST test split.
