"""Pack eight transparent samples from each local Shenshen animation."""

import argparse
from pathlib import Path

from PIL import Image


SEQUENCES = {
    'snack': 'g0dd992fb7fb5',
    'play': 'gad54da175ba8',
    'happy': 'g4f737e44ea67',
}
SIZE = 180
FRAMES = 8
DESKTOP = Path(__file__).resolve().parents[1]


def pack(source: Path, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    for pose, key in SEQUENCES.items():
        room, = source.glob(f'*.{key}')
        files = sorted(room.glob('f_*.webp'))
        if len(files) < FRAMES:
            raise ValueError(f'{pose} needs at least {FRAMES} source frames')
        samples = []
        for index in range(FRAMES):
            with Image.open(files[round(index * (len(files) - 1) / (FRAMES - 1))]) as image:
                samples.append(image.convert('RGBA'))
        boxes = [frame.getchannel('A').getbbox() for frame in samples]
        occupied = [box for box in boxes if box]
        if not occupied:
            raise ValueError(f'{pose} has no visible pixels')
        bounds = tuple(operation(box[edge] for box in occupied)
                       for edge, operation in enumerate((min, min, max, max)))
        atlas = Image.new('RGBA', (FRAMES * SIZE, SIZE))
        for index, frame in enumerate(samples):
            frame = frame.crop(bounds)
            frame.thumbnail((SIZE - 8, SIZE - 8), Image.Resampling.LANCZOS)
            atlas.paste(frame, (index * SIZE + (SIZE - frame.width) // 2, SIZE - frame.height - 4))
        atlas.save(destination / f'xiaoman_{pose}.png', optimize=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=DESKTOP.parents[2] /
                        'dsh-pet-indesktop/assets/characters/shenshen/frameseq/random')
    parser.add_argument('--destination', type=Path, default=DESKTOP / 'src/fullawake_desktop/ui/sprites')
    args = parser.parse_args()
    pack(args.source, args.destination)
